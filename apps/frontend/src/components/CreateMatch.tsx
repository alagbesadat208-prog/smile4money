import React, { useState, useCallback } from 'react';
import { Address, Networks } from '@stellar/stellar-sdk';
import { validateAndConvertXlmToStroops, countDecimalPlaces } from '../utils/xlm-precision';
import { createTraceparent } from '../utils/trace-context';

type Platform = 'lichess' | 'chesscom';
type TokenType = 'xlm' | 'usdc';
type Status = 'idle' | 'validating' | 'pending' | 'success' | 'error';

// Stellar stroop bounds for stake_amount.
// 1 stroop is the minimum transferable unit; the contract enforces an upper
// cap of 10 trillion stroops to guard against overflow edge cases.
const MIN_STAKE_STROOPS = 1n;
const MAX_STAKE_STROOPS = 10_000_000_000_000n;

interface CreateMatchProps {
  contractId: string;
  player1Address: string | null;
  networkPassphrase?: string;
  rpcUrl?: string;
  apiBaseUrl?: string;
  /** Pre-known game IDs that already have a match; duplicates are rejected. */
  knownGameIds?: string[];
  onCreateMatch?: (data: {
    player2: string;
    stakeAmount: string;
    token: TokenType;
    gameId: string;
    platform: Platform;
    platformUsername?: string;
    networkPassphrase: string;
    rpcUrl: string;
  }) => Promise<string>;
}

interface FormData {
  player2: string;
  stakeAmount: string;
  gameId: string;
  platform: Platform;
  platformUsername: string;
}

interface FormErrors {
  player2?: string;
  stakeAmount?: string;
  stakeAmountWarning?: string;
  gameId?: string;
  platformUsername?: string;
  gameValidation?: string;
}

const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const TOKEN_ADDRESSES: Record<TokenType, string> = {
  xlm: 'native',
  usdc: '', // Would be populated from env/config
};

function isValidStellarAddress(address: string): boolean {
  try {
    Address.fromString(address);
    return true;
  } catch {
    return false;
  }
}

function validateForm(data: FormData, knownGameIds: string[] = []): FormErrors {
  const errors: FormErrors = {};

  if (!data.player2.trim()) {
    errors.player2 = 'Player 2 address is required';
  } else if (!isValidStellarAddress(data.player2)) {
    errors.player2 = 'Invalid Stellar address';
  }

  if (!data.stakeAmount.trim()) {
    errors.stakeAmount = 'Stake amount is required';
  } else {
    const raw = data.stakeAmount.trim();
    const validation = validateAndConvertXlmToStroops(raw);
    
    if (!validation.valid) {
      errors.stakeAmount = validation.message || 'Invalid stake amount';
    } else if (validation.stroops !== undefined) {
      // Check bounds
      if (validation.stroops < MIN_STAKE_STROOPS) {
        errors.stakeAmount = `Stake amount must be at least 1 stroop (${(1n / BigInt(10_000_000)).toString()} XLM)`;
      } else if (validation.stroops > MAX_STAKE_STROOPS) {
        errors.stakeAmount = `Stake amount must be at most ${(MAX_STAKE_STROOPS / BigInt(10_000_000)).toString()} XLM`;
      }
      // Set warning if decimal places were provided but capped at 7
      if (validation.decimals === 7) {
        errors.stakeAmountWarning = 'Precision capped at 7 decimal places (1 stroop minimum).';
      }
    }
  }

  if (!data.gameId.trim()) {
    errors.gameId = 'Game ID is required';
  } else if (data.gameId.length > 64) {
    errors.gameId = 'Game ID must be 64 characters or fewer';
  } else if (knownGameIds.includes(data.gameId.trim())) {
    errors.gameId = 'A match with this game ID already exists';
  }

  if (data.platform === 'chesscom' && !data.platformUsername.trim()) {
    errors.platformUsername =
      'Chess.com username is required to validate the game exists in player archives';
  }

  return errors;
}

interface ValidateGameResponse {
  valid: boolean;
  platform: string;
  gameId: string;
  status?: string;
  whitePlayer?: string;
  blackPlayer?: string;
  result?: string | null;
  message?: string;
  error?: string;
  details?: string;
}

async function validateGameOnPlatform(
  apiBaseUrl: string,
  platform: Platform,
  gameId: string,
  platformUsername?: string,
): Promise<{ valid: boolean; message?: string }> {
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/api/validate-game`;
  const backendPlatform = platform === 'chesscom' ? 'chessdotcom' : platform;

  const payload: Record<string, string> = {
    gameId,
    platform: backendPlatform,
  };
  if (platform === 'chesscom' && platformUsername) {
    payload.username = platformUsername;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // #123 — starts the trace the backend carries through oracle jobs.
      traceparent: createTraceparent(),
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as ValidateGameResponse;

  if (response.ok && data.valid) {
    return { valid: true };
  }

  const msg =
    data.message ||
    data.error ||
    data.details ||
    `Game validation failed with status ${response.status}`;
  return { valid: false, message: msg };
}

export function CreateMatch({
  contractId,
  player1Address,
  networkPassphrase = Networks.TESTNET,
  rpcUrl = 'https://soroban-testnet.stellar.org',
  apiBaseUrl = '/',
  knownGameIds = [],
  onCreateMatch,
}: CreateMatchProps) {
  const [formData, setFormData] = useState<FormData>({
    player2: '',
    stakeAmount: '',
    gameId: '',
    platform: 'lichess',
    platformUsername: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<Status>('idle');
  const [token, setToken] = useState<TokenType>('xlm');
  const [matchId, setMatchId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  function updateField(
    key: 'player2' | 'stakeAmount' | 'gameId' | 'platform' | 'platformUsername',
    value: string,
  ) {
    const next = { ...formData, [key]: value } as FormData;
    setFormData(next);
    if (errors[key as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    }
    if (key === 'platform' || key === 'gameId' || key === 'platformUsername') {
      setErrors((prev) => ({ ...prev, gameValidation: undefined }));
    }
  }

  function validateAndUpdate(
    key: 'player2' | 'stakeAmount' | 'gameId' | 'platform' | 'platformUsername',
    value: string,
  ) {
    const next = { ...formData, [key]: value } as FormData;
    setFormData(next);
    const validationErrors = validateForm(next, knownGameIds);
    setErrors((prev) => ({ ...prev, [key]: validationErrors[key as keyof FormErrors] }));
  }

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const validationErrors = validateForm(formData, knownGameIds);
      setErrors(validationErrors);

      if (Object.keys(validationErrors).length > 0) {
        return;
      }

      if (!player1Address) {
        setErrorMsg('Please connect your wallet first');
        setStatus('error');
        return;
      }

      setStatus('validating');
      setErrorMsg('');
      setErrors((prev) => ({ ...prev, gameValidation: undefined }));

      try {
        const validation = await validateGameOnPlatform(
          apiBaseUrl,
          formData.platform,
          formData.gameId,
          formData.platformUsername || undefined,
        );

        if (!validation.valid) {
          setErrors((prev) => ({
            ...prev,
            gameValidation:
              validation.message ||
              'This game does not exist on the selected platform. Please verify the Game ID and try again.',
          }));
          setStatus('error');
          setErrorMsg(
            validation.message ||
              'Game not found on platform. Please check the Game ID and try a valid one.',
          );
          return;
        }
      } catch (err) {
        const networkMsg =
          err instanceof Error ? err.message : 'Could not reach the game validation service';
        setStatus('error');
        setErrorMsg(`Unable to validate game: ${networkMsg}`);
        return;
      }

      setStatus('pending');

      try {
        // Convert decimal XLM to stroops
        const stakeValidation = validateAndConvertXlmToStroops(formData.stakeAmount.trim());
        if (!stakeValidation.valid || stakeValidation.stroops === undefined) {
          throw new Error('Invalid stake amount');
        }

        const result = await onCreateMatch?.({
          player2: formData.player2,
          stakeAmount: stakeValidation.stroops.toString(),
          token,
          gameId: formData.gameId,
          platform: formData.platform,
          platformUsername: formData.platformUsername || undefined,
          networkPassphrase,
          rpcUrl,
        });

        if (result) {
          setMatchId(result);
          setStatus('success');
        } else {
          throw new Error('Failed to create match');
        }
      } catch (err) {
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : 'Failed to create match');
      }
    },
    [formData, player1Address, token, apiBaseUrl, knownGameIds, onCreateMatch, networkPassphrase, rpcUrl],
  );

  function resetForm() {
    setFormData({
      player2: '',
      stakeAmount: '',
      gameId: '',
      platform: 'lichess',
      platformUsername: '',
    });
    setErrors({});
    setStatus('idle');
    setMatchId(null);
    setErrorMsg('');
  }

  const isBusy = status === 'validating' || status === 'pending';
  const isSubmitting = status === 'pending';
  const isValidating = status === 'validating';
  // Filter out keys whose value is undefined (e.g. cleared gameValidation)
  // so that `{gameValidation: undefined}` does not count as having errors.
  const hasErrors = Object.values(errors).some((v) => v !== undefined);

  return (
    <div className="create-match" data-testid="create-match">
      <h2 className="create-match-title">Create New Match</h2>

      {matchId && (
        <div className="match-result" data-testid="match-success">
          <p className="success-message">Match created successfully!</p>
          <p className="match-id">
            Match ID: <strong>{matchId}</strong>
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={resetForm}
            data-testid="create-another-btn"
          >
            Create Another Match
          </button>
        </div>
      )}

      {!matchId && (
        <form onSubmit={handleSubmit} noValidate data-testid="create-match-form">
          {/* Token selector */}
          <div className="form-group">
            <label>Stake Token</label>
            <div className="token-toggle" role="group" aria-label="Select token">
              <button
                type="button"
                className={`toggle-btn${token === 'xlm' ? ' active' : ''}`}
                onClick={() => setToken('xlm')}
                aria-pressed={token === 'xlm'}
                data-testid="toggle-xlm"
              >
                XLM
              </button>
              <button
                type="button"
                className={`toggle-btn${token === 'usdc' ? ' active' : ''}`}
                onClick={() => setToken('usdc')}
                aria-pressed={token === 'usdc'}
                data-testid="toggle-usdc"
              >
                USDC
              </button>
            </div>
          </div>

          {/* Player 2 Address */}
          <div className="form-group">
            <label htmlFor="player2-address">Player 2 Address</label>
            <input
              id="player2-address"
              type="text"
              value={formData.player2}
              onChange={(e) => validateAndUpdate('player2', e.target.value)}
              placeholder="G..."
              disabled={isBusy}
              data-testid="player2-input"
              aria-invalid={!!errors.player2}
            />
            {errors.player2 && (
              <span className="error-message" data-testid="player2-error">
                {errors.player2}
              </span>
            )}
          </div>

          {/* Stake Amount */}
          <div className="form-group">
            <label htmlFor="stake-amount">Stake Amount (XLM)</label>
            <input
              id="stake-amount"
              type="text"
              inputMode="decimal"
              value={formData.stakeAmount}
              onChange={(e) => validateAndUpdate('stakeAmount', e.target.value)}
              disabled={isBusy}
              placeholder="e.g. 1.5 (converts to 15,000,000 stroops)"
              data-testid="stake-amount-input"
              aria-invalid={!!errors.stakeAmount}
            />
            {errors.stakeAmount && (
              <span className="error-message" data-testid="stake-amount-error">
                {errors.stakeAmount}
              </span>
            )}
            {errors.stakeAmountWarning && !errors.stakeAmount && (
              <span className="warning-message" data-testid="stake-amount-warning">
                ⚠️ {errors.stakeAmountWarning}
              </span>
            )}
          </div>

          {/* Game ID */}
          <div className="form-group">
            <label htmlFor="game-id">Game ID</label>
            <input
              id="game-id"
              type="text"
              value={formData.gameId}
              onChange={(e) => updateField('gameId', e.target.value)}
              disabled={isBusy}
              placeholder="Enter game ID from platform"
              data-testid="game-id-input"
              aria-invalid={!!errors.gameId || !!errors.gameValidation}
            />
            {errors.gameId && (
              <span className="error-message" data-testid="game-id-error">
                {errors.gameId}
              </span>
            )}
          </div>

          {/* Platform Username (required for chess.com) */}
          {formData.platform === 'chesscom' && (
            <div className="form-group">
              <label htmlFor="platform-username">
                Chess.com Username <span className="required-hint">(required)</span>
              </label>
              <input
                id="platform-username"
                type="text"
                value={formData.platformUsername}
                onChange={(e) => validateAndUpdate('platformUsername', e.target.value)}
                disabled={isBusy}
                placeholder="Your Chess.com username to verify game in archives"
                data-testid="platform-username-input"
                aria-invalid={!!errors.platformUsername}
              />
              {errors.platformUsername && (
                <span className="error-message" data-testid="platform-username-error">
                  {errors.platformUsername}
                </span>
              )}
              <small className="field-hint">
                Chess.com requires a player username to look up the game in their archives.
              </small>
            </div>
          )}

          {/* Platform Selector */}
          <div className="form-group">
            <label>Platform</label>
            <div className="platform-selector" role="group" aria-label="Select platform">
              <button
                type="button"
                className={`platform-btn${formData.platform === 'lichess' ? ' active' : ''}`}
                onClick={() => updateField('platform', 'lichess')}
                aria-pressed={formData.platform === 'lichess'}
                data-testid="platform-lichess"
                disabled={isBusy}
              >
                Lichess
              </button>
              <button
                type="button"
                className={`platform-btn${formData.platform === 'chesscom' ? ' active' : ''}`}
                onClick={() => updateField('platform', 'chesscom')}
                aria-pressed={formData.platform === 'chesscom'}
                data-testid="platform-chesscom"
                disabled={isBusy}
              >
                Chess.com
              </button>
            </div>
          </div>

          {/* Game validation info / errors */}
          {errors.gameValidation && (
            <div className="validation-feedback error" role="alert" data-testid="game-validation-error">
              <strong>Game not found:</strong> {errors.gameValidation}
            </div>
          )}
          {isValidating && (
            <div className="validation-feedback info" data-testid="game-validating">
              Verifying game exists on {formData.platform === 'lichess' ? 'Lichess' : 'Chess.com'}…
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            className="btn btn-submit"
            disabled={isBusy || hasErrors}
            data-testid="submit-match-btn"
            aria-busy={isBusy}
          >
            {isValidating
              ? 'Validating Game…'
              : isSubmitting
                ? 'Creating Match…'
                : 'Create Match'}
          </button>

          {/* Error Message */}
          {status === 'error' && !errors.gameValidation && (
            <p className="feedback error" role="alert" data-testid="create-match-error">
              {errorMsg}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export default CreateMatch;
