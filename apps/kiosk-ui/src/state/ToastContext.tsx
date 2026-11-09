import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Card, XIcon } from "@facaamigos/ui";

type ToastVariant = "success" | "error";

interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
}

interface ToastValue {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

const DISMISS_MS: Record<ToastVariant, number> = { success: 4000, error: 6000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, variant, message }]);
      setTimeout(() => dismiss(id), DISMISS_MS[variant]);
    },
    [dismiss],
  );

  // Memoizado de propósito: usePrintFailureAlerts e useSessionReportFailureAlerts
  // têm `toast` nas dependências do efeito que assina o canal Realtime. Um
  // objeto novo a cada render recriava a assinatura a cada toast mostrado ou
  // fechado, e fazia loadContacts (CrmWhatsappTab) refazer a busca em loop
  // quando a própria busca falhava e mostrava um toast de erro.
  const value = useMemo<ToastValue>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        style={{
          position: "fixed",
          top: "16px",
          right: "16px",
          zIndex: 5000,
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          maxWidth: "360px",
        }}
      >
        {toasts.map((t) => (
          <Card
            key={t.id}
            // role="status" (sucesso) e role="alert" (erro) em vez de
            // aria-live no container: cada toast é inserido de novo no
            // DOM, e um elemento com esses roles já-presente-no-DOM é
            // anunciado sozinho pelo leitor de tela ao entrar — não
            // depende de "a região mudou". É o mesmo padrão de libs como
            // sonner/react-hot-toast. Sem isso, nenhum sucesso/erro do
            // quiosque (que hoje só aparece visualmente e some sozinho)
            // chegava a quem usa leitor de tela.
            role={t.variant === "error" ? "alert" : "status"}
            style={{
              padding: "12px 16px",
              minWidth: "280px",
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
              borderLeft: `4px solid ${t.variant === "success" ? "var(--color-success)" : "var(--color-error)"}`,
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <span aria-hidden="true" style={{ fontSize: "16px", lineHeight: 1 }}>{t.variant === "success" ? "✓" : "⚠"}</span>
            <span style={{ flex: 1, fontSize: "13px", color: "var(--text-primary)" }}>
              <span className="sr-only">{t.variant === "success" ? "Sucesso: " : "Erro: "}</span>
              {t.message}
            </span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Fechar aviso"
              title="Fechar aviso"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--text-muted)",
                fontSize: "14px",
                lineHeight: 1,
                padding: 0,
              }}
            >
              <XIcon />
            </button>
          </Card>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast precisa estar dentro de <ToastProvider>");
  return ctx;
}
