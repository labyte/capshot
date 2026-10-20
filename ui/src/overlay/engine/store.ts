//! 极小外部 store：状态变更只发生在**交互边界**（pointerdown/up、切工具、撤销重做、提交），
//! 每帧连续数据（实时选区、光标位）走 controller 的可变 ref，不进这里。
//! React 侧用 useSyncExternalStore 订阅；命令式 controller 直接读写。

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const next = typeof patch === "function" ? patch(state) : patch;
      let changed = false;
      for (const k in next) {
        if ((state as never)[k] !== (next as never)[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export type Store<T extends object> = ReturnType<typeof createStore<T>>;
