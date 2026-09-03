import { useState, useCallback } from "react";

/**
 * useConfirm: a tiny hook that pairs with <ConfirmDialog /> to replace
 * window.confirm. Call `confirm({...})` to open the dialog; `state` is what
 * you spread into <ConfirmDialog /> via `open={!!state}` etc.
 *
 * Example:
 *   const { state, confirm, close } = useConfirm();
 *   confirm({ title: "Delete?", description: "...", onConfirm: () => doDelete() });
 *   <ConfirmDialog open={!!state} onOpenChange={(o) => !o && close()} {...state} />
 */
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => setState(opts), []);
  const close = useCallback(() => setState(null), []);
  return { state, confirm, close };
}
