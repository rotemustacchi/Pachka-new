"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastVariant = "info" | "success" | "error";

interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly variant: ToastVariant;
}

interface ToastContextValue {
  readonly show: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<ToastVariant, string> = {
  info: "bg-ink text-paper",
  success: "bg-affirm text-paper",
  error: "bg-alert text-paper",
};

const AUTO_DISMISS_MS = 5000;

export interface ToastProviderProps {
  readonly children: ReactNode;
}

/**
 * A shared toast queue rendered into a single `aria-live` region, so a
 * screen reader announces each toast as it appears without re-announcing
 * the whole list.
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current, { id, message, variant }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-4 end-4 z-50 flex flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={["flex items-center gap-3 rounded-button px-4 py-3 text-sm shadow-lg", VARIANT_STYLES[toast.variant]].join(
              " ",
            )}
          >
            <span>{toast.message}</span>
            <button type="button" onClick={() => dismiss(toast.id)} className="font-bold" aria-label="סגירה">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
