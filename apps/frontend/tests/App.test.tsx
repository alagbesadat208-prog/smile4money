import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { App } from '../src/App';

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    window.history.pushState({}, '', '/');
  });

  it('composes providers and renders the home screen', () => {
    render(<App />);
    expect(screen.getByTestId('network-badge')).toBeInTheDocument();
    expect(screen.getByTestId('history-page')).toBeInTheDocument();
    expect(screen.queryByTestId('claim-burn')).not.toBeInTheDocument();
  });

  it('toggles the theme through the composed providers', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /switch to dark mode/i }));
    expect(localStorage.getItem('smile4money-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /switch to light mode/i }));
    expect(localStorage.getItem('smile4money-theme')).toBe('light');
  });
});
