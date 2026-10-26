import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Traps focus inside `container` while `active` is true.
 *
 * - On activation: remembers the previously focused element and moves focus to
 *   the first focusable element inside the container.
 * - While active: Tab cycles focus within the container; Shift+Tab cycles
 *   backwards.
 * - On deactivation/unmount: restores focus to the previously focused element,
 *   so keyboard users are never left with focus lost in the document after a
 *   dialog closes.
 *
 * @param containerRef Ref to the dialog/container element.
 * @param active Whether the trap is currently active (dialog open).
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    previousFocus.current = document.activeElement as HTMLElement | null;

    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first) first.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      if (focusable.length === 0) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (document.activeElement === first) last?.focus();
      } else if (document.activeElement === last) {
        first?.focus();
      }
    }

    container.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      previousFocus.current?.focus?.();
    };
  }, [active, containerRef]);
}
