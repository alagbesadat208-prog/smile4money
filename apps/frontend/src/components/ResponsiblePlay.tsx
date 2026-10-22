import { useState } from 'react';
import { validateAndConvertXlmToStroops } from '../utils/xlm-precision';
import { formatStroops } from '../utils/payout';
import {
  SELF_EXCLUSION_PERIODS,
  activeExclusion,
  effectiveSettings,
  setStakeLimit,
  startSelfExclusion,
  type SelfExclusionPeriod,
} from '../utils/responsible-play';

const PERIOD_LABELS: Record<SelfExclusionPeriod, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '6m': '6 months',
};

interface ResponsiblePlayProps {
  address: string | null;
}

/**
 * Self-exclusion and stake-limit controls for the connected address (#114).
 * See docs/responsible-play.md for what they do and do not cover.
 */
export function ResponsiblePlay({ address }: ResponsiblePlayProps) {
  const [confirming, setConfirming] = useState<SelfExclusionPeriod | null>(null);
  const [limitInput, setLimitInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  if (!address) return null;

  const until = activeExclusion(address);
  const settings = effectiveSettings(address);

  const exclude = (period: SelfExclusionPeriod) => {
    const result = startSelfExclusion(address, period);
    setConfirming(null);
    setMessage(
      result.saved
        ? `Self-excluded until ${new Date(result.until).toLocaleString()}.`
        : "Couldn't save the self-exclusion: this browser's storage is unavailable.",
    );
    refresh();
  };

  const applyLimit = (remove: boolean) => {
    let limit: bigint | null = null;
    if (!remove) {
      const parsed = validateAndConvertXlmToStroops(limitInput.trim());
      if (!parsed.valid || parsed.stroops === undefined || parsed.stroops <= 0n) {
        setMessage('Enter a positive stake limit.');
        return;
      }
      limit = parsed.stroops;
    }
    const result = setStakeLimit(address, limit);
    if (!result.saved) {
      setMessage("Couldn't save the stake limit: this browser's storage is unavailable.");
    } else if (result.effectiveAt > Date.now()) {
      setMessage(
        `Your change takes effect on ${new Date(result.effectiveAt).toLocaleString()}. Raising or removing a limit waits 24 hours.`,
      );
    } else {
      setMessage('Stake limit updated.');
    }
    refresh();
  };

  return (
    <section
      className="responsible-play"
      aria-label="Responsible play"
      data-testid="responsible-play"
    >
      <h3>Responsible play</h3>
      <p className="field-hint">
        These controls apply to this app in this browser only. They are not enforced by the
        contract.
      </p>

      {until !== null ? (
        <p className="feedback warning" role="status" data-testid="self-exclusion-active">
          Self-excluded until {new Date(until).toLocaleString()}. Creating matches and depositing
          are blocked until then.
        </p>
      ) : (
        <div className="form-group">
          <p className="field-hint">Take a break from wagering:</p>
          {confirming === null ? (
            <div className="self-exclusion-periods" role="group" aria-label="Self-exclusion period">
              {(Object.keys(SELF_EXCLUSION_PERIODS) as SelfExclusionPeriod[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="btn"
                  onClick={() => setConfirming(p)}
                  data-testid={`self-exclusion-${p}`}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
          ) : (
            <div role="alertdialog" aria-label="Confirm self-exclusion">
              <p className="feedback warning">
                You won&apos;t be able to create matches or deposit for {PERIOD_LABELS[confirming]},
                and this can&apos;t be undone early.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => exclude(confirming)}
                data-testid="self-exclusion-confirm"
              >
                Confirm self-exclusion
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <div className="form-group">
        <label htmlFor="stake-limit">Maximum stake per match</label>
        <p className="field-hint" data-testid="stake-limit-current">
          {(settings.stakeLimit !== undefined
            ? `Current limit: ${formatStroops(BigInt(settings.stakeLimit))}.`
            : 'No limit set.') +
            (settings.pendingLimit
              ? ` Pending change on ${new Date(settings.pendingLimit.effectiveAt).toLocaleString()}.`
              : '')}
        </p>
        <input
          id="stake-limit"
          type="text"
          inputMode="decimal"
          value={limitInput}
          onChange={(e) => setLimitInput(e.target.value)}
          data-testid="stake-limit-input"
        />
        <button
          type="button"
          className="btn"
          onClick={() => applyLimit(false)}
          data-testid="stake-limit-save"
        >
          Set limit
        </button>
        {settings.stakeLimit !== undefined && (
          <button
            type="button"
            className="btn"
            onClick={() => applyLimit(true)}
            data-testid="stake-limit-remove"
          >
            Remove limit
          </button>
        )}
      </div>

      {message && (
        <p className="feedback info" role="status" data-testid="responsible-play-message">
          {message}
        </p>
      )}
    </section>
  );
}

export default ResponsiblePlay;
