#![no_std]

use smile4money_common::constants::MATCH_TTL_LEDGERS;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Map, String, Vec,
};

const SCHEMA_VERSION: u32 = 2;
const INSTANCE_LIFETIME_THRESHOLD: u32 = MATCH_TTL_LEDGERS;
const INSTANCE_BUMP_AMOUNT: u32 = MATCH_TTL_LEDGERS;
const REGISTRATION_TTL_LEDGERS: u32 = 100_000;
const REGISTRATION_TTL_BUMP: u32 = 100_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    Unauthorized = 1,
    ContractPaused = 2,
    MaxEventsReached = 3,
    ContractNotFound = 4,
    AlreadyRegistered = 5,
    Overflow = 6,
    InvalidName = 7,
    ReservedName = 8,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    MaxEvents,
    Registrations,
    RegistrationCount,
    Registration(String),
    Events,
    SchemaVersion,
}

/// Registry names are lowercase ASCII identifiers, 1–32 bytes. Hyphens and
/// underscores are allowed after the first lowercase letter. Names are never
/// normalized: aliases and mixed case are rejected at the contract boundary.
pub fn validate_name(name: &String) -> Result<(), Error> {
    let length = name.len() as usize;
    if length == 0 || length > 32 {
        return Err(Error::InvalidName);
    }
    let mut bytes = [0_u8; 32];
    name.copy_into_slice(&mut bytes[..length]);
    let bytes = &bytes[..length];
    if !bytes[0].is_ascii_lowercase() {
        return Err(Error::InvalidName);
    }
    if bytes
        .iter()
        .any(|b| !(b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_'))
    {
        return Err(Error::InvalidName);
    }
    if bytes == b"admin" || bytes == b"system" || bytes == b"registry" {
        return Err(Error::ReservedName);
    }
    Ok(())
}

#[contracttype]
#[derive(Clone)]
pub struct ContractRecord {
    /// The registry administrator owns all records and may maintain or remove them.
    pub registrant: Address,
    pub contract_id: String,
    pub active: bool,
    /// Incremented whenever the record is updated.
    pub revision: u32,
    /// Ledger at which this revision became effective.
    pub effective_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct RegistryHealth {
    pub initialized: bool,
    pub schema_version: u32,
    pub administrator: Option<Address>,
    pub network_id: soroban_sdk::BytesN<32>,
}

#[contract]
pub struct ContractRegistry;

#[contractimpl]
impl ContractRegistry {
    pub fn initialize(env: Env, admin: Address, max_events: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Paused, &false);
        storage.set(&DataKey::MaxEvents, &max_events);
        storage.set(
            &DataKey::Registrations,
            &Map::<String, ContractRecord>::new(&env),
        );
        storage.set(&DataKey::RegistrationCount, &0_u32);
        storage.set(&DataKey::Events, &Vec::<String>::new(&env));
        storage.set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
        storage.extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Safe operational metadata. On legacy instances without a schema marker,
    /// the initialized registry is reported as schema 1 until migrated.
    pub fn health(env: Env) -> RegistryHealth {
        let administrator: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        let schema_version = if administrator.is_none() {
            0
        } else {
            env.storage()
                .instance()
                .get(&DataKey::SchemaVersion)
                .unwrap_or(1)
        };
        RegistryHealth {
            initialized: administrator.is_some(),
            schema_version,
            administrator,
            network_id: env.ledger().network_id(),
        }
    }

    /// Upgrade an initialized legacy registry to the current metadata schema.
    pub fn migrate(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SchemaVersion)
            .unwrap_or(1);
        if version < SCHEMA_VERSION {
            env.storage()
                .instance()
                .set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
        }
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn register_contract(env: Env, caller: Address, contract_id: String) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        Self::require_admin(&env, &caller)?;
        validate_name(&contract_id)?;
        let mut registrations: Map<String, ContractRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Registrations)
            .unwrap_or_else(|| Map::new(&env));
        if registrations.contains_key(contract_id.clone()) {
            return Err(Error::AlreadyRegistered);
        }
        let record = ContractRecord {
            registrant: caller,
            contract_id: contract_id.clone(),
            active: true,
            revision: 1,
            effective_ledger: env.ledger().sequence(),
        };
        registrations.set(contract_id.clone(), record.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Registration(contract_id), &record);
        env.storage().persistent().extend_ttl(
            &DataKey::Registration(record.contract_id.clone()),
            REGISTRATION_TTL_LEDGERS,
            REGISTRATION_TTL_BUMP,
        );
        env.storage()
            .instance()
            .set(&DataKey::Registrations, &registrations);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RegistrationCount)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::RegistrationCount,
            &count.checked_add(1).ok_or(Error::Overflow)?,
        );
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn update_contract(env: Env, caller: Address, contract_id: String) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        Self::require_admin(&env, &caller)?;
        validate_name(&contract_id)?;
        let key = DataKey::Registration(contract_id.clone());
        let mut record: ContractRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ContractNotFound)?;
        record.revision = record.revision.checked_add(1).ok_or(Error::Overflow)?;
        record.effective_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            REGISTRATION_TTL_LEDGERS,
            REGISTRATION_TTL_BUMP,
        );
        let mut registrations: Map<String, ContractRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Registrations)
            .unwrap_or_else(|| Map::new(&env));
        registrations.set(contract_id, record);
        env.storage()
            .instance()
            .set(&DataKey::Registrations, &registrations);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn deregister_contract(
        env: Env,
        caller: Address,
        contract_id: String,
    ) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        Self::require_admin(&env, &caller)?;
        validate_name(&contract_id)?;
        let key = DataKey::Registration(contract_id.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::ContractNotFound);
        }
        env.storage().persistent().remove(&key);
        let mut registrations: Map<String, ContractRecord> = env
            .storage()
            .instance()
            .get(&DataKey::Registrations)
            .unwrap_or_else(|| Map::new(&env));
        registrations.remove(contract_id);
        env.storage()
            .instance()
            .set(&DataKey::Registrations, &registrations);
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RegistrationCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::RegistrationCount, &count.saturating_sub(1));
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn registration_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RegistrationCount)
            .unwrap_or(0)
    }

    pub fn get_registration(env: Env, contract_id: String) -> Result<ContractRecord, Error> {
        validate_name(&contract_id)?;
        env.storage()
            .persistent()
            .get(&DataKey::Registration(contract_id))
            .ok_or(Error::ContractNotFound)
    }

    pub fn submit_event(env: Env, caller: Address, event_name: String) -> Result<(), Error> {
        Self::ensure_not_paused(&env)?;
        Self::require_admin(&env, &caller)?;
        let max_events: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(0);
        let mut events: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::Events)
            .unwrap_or_else(|| Vec::new(&env));
        if events.len() >= max_events {
            return Err(Error::MaxEventsReached);
        }
        events.push_back(event_name);
        env.storage().instance().set(&DataKey::Events, &events);
        Self::bump_instance(&env);
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        if admin != *caller {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        Ok(())
    }

    fn ensure_not_paused(env: &Env) -> Result<(), Error> {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }
}

#[cfg(test)]
mod test;
