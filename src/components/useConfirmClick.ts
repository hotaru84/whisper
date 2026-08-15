import { useEffect, useRef, useState } from "react";

/** How long an armed button stays armed before disarming itself. Long enough
 * to read the changed label and click again, short enough that a button left
 * armed by a mis-click doesn't stay dangerous. */
const CONFIRM_TIMEOUT_MS = 3000;

/**
 * Two-click confirmation for a destructive action, in place of a modal.
 *
 * The first click only *arms* the button -- callers re-label it and switch it
 * to the `destructive` variant while `confirming` is true -- and the second
 * click within the timeout performs the action. Chosen over a dialog because
 * the actions this guards (deleting one recording) are cheap to redo and
 * frequent enough that a modal for each would be the heavier cost; the point
 * is only that no single click can destroy anything.
 *
 * `stopPropagation` is built in: both call sites sit inside a clickable row or
 * toolbar whose own handler must not fire.
 */
export function useConfirmClick(onConfirm: () => void): {
  confirming: boolean;
  onClick: (e: React.MouseEvent) => void;
} {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // A row can be unmounted (by this very delete, or by a history refresh)
  // while its disarm timer is still pending.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
      return;
    }
    clearTimeout(timerRef.current);
    setConfirming(false);
    onConfirm();
  };

  return { confirming, onClick };
}
