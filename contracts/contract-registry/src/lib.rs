#![no_std]

use smile4money_common::constants::MATCH_TTL_LEDGERS;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    Unauthorized = 1,
    ContractPaused = 2,
    MaxEventsReached = 3,
    ContractNotFound = 4,
    AlreadyRegistered = 5,
    Overflow = 6,
    InvalidRange = 7,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    MaxEvents,
    /// Counter of live registrations; kept in instance storage for pagination.
    RegistrationCount,
    /// Per-contract registration record, stored in persistent storage under
    /// its own entry keyed by the contract's `Symbol`. This keeps reads O(1)
    /// and avoids deserializing (and eventually outgrowing) a single map.
    Registration(Symbol),
    Events,
    Names,
}

#[contracttype]
#[derive(Clone)]
pub struct ContractRecord {
    pub registrant: Address,
    pub contract_address: Address,
    pub contract_id: Symbol,
    pub active: bool,
}

#[contract]
pub struct ContractRegistry;

/// Maximum number of names returned by one enumeration call.
pub const MAX_PAGE_SIZE: u32 = 50;
const REGISTRATION_TTL_LEDGERS: u32 = MATCH_TTL_LEDGERS;
const REGISTRATION_TTL_BUMP: u32 = 50_000;

/// Instance-storage TTL threshold (~30 days at 5 s/ledger).
/// Shared with the escrow contract so both contracts' instance entries
/// expire together — see `smile4money_common::constants::MATCH_TTL_LEDGERS`.
const INSTANCE_LIFETIME_THRESHOLD: u32 = MATCH_TTL_LEDGERS;
/// Instance-storage TTL bump amount (same 30-day window as the threshold).
const INSTANCE_BUMP_AMOUNT: u32 = MATCH_TTL_LEDGERS;

#[contractimpl]
impl ContractRegistry {
    pub fn initialize(env: Env, admin: Address, max_events: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::MaxEvents, &max_events);
        env.storage()
            .instance()
            .set(&DataKey::RegistrationCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::Names, &Vec::<Symbol>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::Events, &Vec::<Symbol>::new(&env));

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    pub fn register_contract(
        env: Env,
        caller: Address,
        contract_id: Symbol,
        contract_address: Address,
    ) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let key = DataKey::Registration(contract_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }
        let count = Self::registration_count(env.clone())
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        let mut names: Vec<Symbol> = env
            .storage()
            .instance()
            .get(&DataKey::Names)
            .unwrap_or_else(|| Vec::new(&env));
        let mut position = 0;
        while position < names.len() && names.get(position).unwrap() < contract_id {
            position += 1;
        }
        names.insert(position, contract_id.clone());
        env.storage().instance().set(&DataKey::Names, &names);
        env.storage()
            .instance()
            .set(&DataKey::RegistrationCount, &count);
        Self::store_registration(
            &env,
            &key,
            &ContractRecord {
                registrant: caller,
                contract_id,
                contract_address,
                active: true,
            },
        );
        Ok(())
    }

    pub fn update_contract(
        env: Env,
        caller: Address,
        contract_id: Symbol,
        contract_address: Address,
    ) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let key = DataKey::Registration(contract_id.clone());
        let mut record: ContractRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ContractNotFound)?;
        let prior_address = record.contract_address.clone();
        record.contract_address = contract_address.clone();
        Self::store_registration(&env, &key, &record);
        env.events().publish(
            (symbol_short!("registry"), symbol_short!("replaced"), 1u32),
            (
                contract_id,
                prior_address,
                contract_address,
                caller,
                env.ledger().sequence(),
            ),
        );
        Ok(())
    }

    pub fn deregister_contract(
        env: Env,
        caller: Address,
        contract_id: Symbol,
    ) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        let key = DataKey::Registration(contract_id.clone());
        let record: ContractRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ContractNotFound)?;
        let is_registrant = record.registrant == caller;
        if !is_registrant {
            let admin: Address = env
                .storage()
                .instance()
                .get(&DataKey::Admin)
                .ok_or(Error::Unauthorized)?;
            if admin != caller {
                return Err(Error::Unauthorized);
            }
        }
        caller.require_auth();
        let mut names: Vec<Symbol> = env
            .storage()
            .instance()
            .get(&DataKey::Names)
            .unwrap_or_else(|| Vec::new(&env));
        if let Some(position) = names.first_index_of(&contract_id) {
            names.remove(position);
        }
        env.storage().persistent().remove(&key);
        env.storage().instance().set(&DataKey::Names, &names);
        env.storage().instance().set(
            &DataKey::RegistrationCount,
            &Self::registration_count(env.clone()).saturating_sub(1),
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Number of live registrations. Use this to bound pagination loops.
    pub fn registration_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RegistrationCount)
            .unwrap_or(0)
    }

    /// Fetch a single registration without deserializing the whole registry.
    pub fn get_registration(env: Env, contract_id: Symbol) -> Result<ContractRecord, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Registration(contract_id))
            .ok_or(Error::ContractNotFound)
    }

    /// Names in ascending Symbol order. Read all pages at the same ledger
    /// snapshot: insertions and removals can shift offsets between ledgers.
    /// Zero limits are rejected; oversized limits are capped; exhausted pages are empty.
    pub fn list_names(env: Env, offset: u32, limit: u32) -> Result<Vec<Symbol>, Error> {
        if limit == 0 {
            return Err(Error::InvalidRange);
        }
        let names: Vec<Symbol> = env
            .storage()
            .instance()
            .get(&DataKey::Names)
            .unwrap_or_else(|| Vec::new(&env));
        let end = core::cmp::min(names.len(), offset.saturating_add(limit.min(MAX_PAGE_SIZE)));
        let mut page = Vec::new(&env);
        for i in offset..end {
            page.push_back(names.get(i).unwrap());
        }
        Ok(page)
    }

    fn store_registration(env: &Env, key: &DataKey, record: &ContractRecord) {
        env.storage().persistent().set(key, record);
        env.storage()
            .persistent()
            .extend_ttl(key, REGISTRATION_TTL_BUMP, REGISTRATION_TTL_LEDGERS);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    pub fn submit_event(env: Env, caller: Address, event_name: Symbol) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        // Only the configured admin may submit registry events.
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        let max_events: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(0);
        let mut events: Vec<Symbol> = env
            .storage()
            .instance()
            .get(&DataKey::Events)
            .unwrap_or_else(|| Vec::new(&env));
        if events.len() >= max_events {
            return Err(Error::MaxEventsReached);
        }
        events.push_back(event_name);
        env.storage().instance().set(&DataKey::Events, &events);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    fn ensure_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
