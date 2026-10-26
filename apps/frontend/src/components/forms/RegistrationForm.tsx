import React, { useState } from 'react';

interface RegistrationFormProps {
  onSubmit?: (data: { email: string; password: string }) => void | Promise<void>;
}

type Fields = { email: string; password: string; confirmPassword: string };
type Errors = Partial<Record<keyof Fields, string>>;

function validateFields({ email, password, confirmPassword }: Fields): Errors {
  const errs: Errors = {};
  if (!email) errs.email = 'Email is required';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = 'Invalid email address';
  if (!password) errs.password = 'Password is required';
  else if (password.length < 8) errs.password = 'Password must be at least 8 characters';
  else if (!/(?=.*[A-Z])(?=.*\d)/.test(password))
    errs.password = 'Password must contain uppercase and a number';
  if (password && confirmPassword && password !== confirmPassword)
    errs.confirmPassword = 'Passwords do not match';
  return errs;
}

export function RegistrationForm({ onSubmit }: RegistrationFormProps) {
  const [fields, setFields] = useState<Fields>({ email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function update(key: keyof Fields, value: string) {
    const next = { ...fields, [key]: value };
    setFields(next);
    // Re-validate with new values so errors clear in real-time
    const errs = validateFields(next);
    setErrors((prev) => ({ ...prev, [key]: errs[key], confirmPassword: errs.confirmPassword }));
  }

  function blur(key: keyof Fields) {
    const errs = validateFields(fields);
    setErrors((prev) => ({ ...prev, [key]: errs[key] }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validateFields(fields);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    if (submitted) return;
    setSubmitting(true);
    setSubmitted(true);
    await onSubmit?.({ email: fields.email, password: fields.password });
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Registration form">
      {/* Email */}
      <div>
        <label htmlFor="reg-email">
          Email <span aria-hidden="true">*</span>
        </label>
        <input
          id="reg-email"
          type="email"
          value={fields.email}
          onChange={(e) => update('email', e.target.value)}
          onBlur={() => blur('email')}
          aria-required="true"
          aria-invalid={errors.email ? 'true' : 'false'}
          aria-describedby={errors.email ? 'reg-email-error' : undefined}
          autoComplete="email"
        />
        {errors.email && (
          <span id="reg-email-error" role="alert" aria-live="polite">
            {errors.email}
          </span>
        )}
      </div>

      {/* Password */}
      <div>
        <label htmlFor="reg-password">
          Password <span aria-hidden="true">*</span>
        </label>
        <input
          id="reg-password"
          type="password"
          value={fields.password}
          onChange={(e) => update('password', e.target.value)}
          onBlur={() => blur('password')}
          aria-required="true"
          aria-invalid={errors.password ? 'true' : 'false'}
          aria-describedby={
            errors.password
              ? 'reg-password-error'
              : 'reg-password-hint'
          }
          autoComplete="new-password"
        />
        <span id="reg-password-hint" className="field-hint">
          At least 8 characters, one uppercase letter, and one number.
        </span>
        {errors.password && (
          <span id="reg-password-error" role="alert" aria-live="polite">
            {errors.password}
          </span>
        )}
      </div>

      {/* Confirm Password */}
      <div>
        <label htmlFor="reg-confirm-password">
          Confirm Password <span aria-hidden="true">*</span>
        </label>
        <input
          id="reg-confirm-password"
          type="password"
          value={fields.confirmPassword}
          onChange={(e) => update('confirmPassword', e.target.value)}
          onBlur={() => blur('confirmPassword')}
          aria-required="true"
          aria-invalid={errors.confirmPassword ? 'true' : 'false'}
          aria-describedby={errors.confirmPassword ? 'reg-confirm-error' : undefined}
          autoComplete="new-password"
        />
        {errors.confirmPassword && (
          <span id="reg-confirm-error" role="alert" aria-live="polite">
            {errors.confirmPassword}
          </span>
        )}
      </div>

      <button type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? 'Registering…' : 'Register'}
      </button>

      {submitted && !submitting && Object.keys(errors).length === 0 && (
        <p role="status" aria-live="polite">
          Registration submitted successfully.
        </p>
      )}
    </form>
  );
}
