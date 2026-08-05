"use client";

import * as React from "react";

/**
 * useFocusTrap — traps keyboard focus within a container element.
 *
 * When active, Tab/Shift+Tab cycles only through focusable elements inside
 * the container. This is critical for dialog accessibility (WAI-ARIA
 * dialog pattern: focus must be trapped while the dialog is open).
 *
 * Usage:
 *   const ref = useFocusTrap(open);
 *   return <div ref={ref}>...</div>;
 *
 * The hook returns a ref to attach to the container. When `active` is true,
 * focus is moved to the first focusable element on mount, and Tab/Shift+Tab
 * are intercepted to cycle within the container.
 */
export function useFocusTrap(active: boolean): React.RefObject<HTMLDivElement> {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!active || !ref.current) return;

    const container = ref.current;
    // Get all focusable elements
    const getFocusable = (): HTMLElement[] => {
      return Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    };

    // Move focus to the first focusable element
    const focusable = getFocusable();
    if (focusable.length > 0) {
      // Slight delay to let the dialog content render
      setTimeout(() => focusable[0].focus(), 50);
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const currentFocusable = getFocusable();
      if (currentFocusable.length === 0) return;

      const first = currentFocusable[0];
      const last = currentFocusable[currentFocusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  return ref;
}
