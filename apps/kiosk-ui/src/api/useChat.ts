import { startVisiblePolling } from "../lib/visiblePolling.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase/client.js";
import { assertValidImageUpload, prepareUpload } from "../lib/imageCompression.js";
import {
  assertChatImage,
  chatAttachmentPath,
  mergeMessages,
  normalizeChatBody,
  type ChatMessage,
} from "../lib/chat.js";

const BUCKET = "fa-chat-attachments";
const PAGE = 100;
// Rede de segurança do Realtime: tablet de loja perde conexão; sem isto a resposta
// do dono só apareceria ao recarregar.
// Rede de segurança do Realtime (que já entrega mensagens novas na hora).
// 45 s -> 2 min, e só com a janela visível; ao voltar a ficar visível o
// listener de visibilitychange abaixo recarrega na hora.
const POLL_MS = 120_000;

interface Options {
  enabled: boolean;
  /** Painel aberto: respostas novas já nascem lidas. */
  panelOpen: boolean;
  /** Contexto automático anexado a cada mensagem enviada. */
  getContext: () => Record<string, string>;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export function useChat({ enabled, panelOpen, getContext }: Options) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelOpenRef = useRef(panelOpen);
  const getContextRef = useRef(getContext);
  panelOpenRef.current = panelOpen;
  getContextRef.current = getContext;

  const refreshUnread = useCallback(async () => {
    try {
      setUnread(await rpc<number>("fa_chat_my_unread"));
    } catch {
      /* mantém o último valor; o próximo ciclo tenta de novo */
    }
  }, []);

  const loadMessages = useCallback(async (tid: string) => {
    const { data, error: err } = await supabase()
      .from("fa_kiosk_chat_messages")
      .select("id, thread_id, sender_employee_id, from_owner, body, attachment_path, context, telegram_sent_at_ms, created_at_ms")
      .eq("thread_id", tid)
      .order("created_at_ms", { ascending: false })
      .limit(PAGE);
    if (err) throw new Error(err.message);
    setMessages((cur) => mergeMessages(cur, (data ?? []) as ChatMessage[]));
  }, []);

  const markRead = useCallback(async () => {
    if (!threadId) return;
    setUnread(0);
    try {
      await rpc<number>("fa_chat_mark_read", { p_thread_id: threadId });
    } catch {
      void refreshUnread();
    }
  }, [threadId, refreshUnread]);

  // Abre a conversa (cria na primeira vez) e carrega o histórico.
  useEffect(() => {
    if (!enabled) {
      setThreadId(null);
      setMessages([]);
      setUnread(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const tid = await rpc<string>("fa_chat_get_or_create_my_thread");
        if (cancelled) return;
        setThreadId(tid);
        await loadMessages(tid);
        await refreshUnread();
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, loadMessages, refreshUnread]);

  // Tempo real (padrão de hooks/usePrintFailureAlerts.ts) + polling de segurança.
  useEffect(() => {
    if (!threadId) return;
    const sync = () => {
      void loadMessages(threadId).catch(() => {});
      void refreshUnread();
    };
    const channel = supabase()
      .channel(`fa_chat_${threadId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fa_kiosk_chat_messages", filter: `thread_id=eq.${threadId}` },
        (payload) => {
          const row = payload.new as ChatMessage | undefined;
          if (!row?.id) return;
          setMessages((cur) => mergeMessages(cur, [row]));
          if (payload.eventType === "INSERT" && row.from_owner) {
            if (panelOpenRef.current) void rpc("fa_chat_mark_read", { p_thread_id: threadId }).catch(() => {});
            else setUnread((n) => n + 1);
          }
        },
      )
      .subscribe();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") sync();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      void supabase().removeChannel(channel);
    };
  }, [threadId, loadMessages, refreshUnread]);

  // Painel aberto = leu.
  useEffect(() => {
    if (panelOpen && threadId && unread > 0) void markRead();
  }, [panelOpen, threadId, unread, markRead]);

  const sendOne = useCallback(
    async (m: ChatMessage, file?: Blob) => {
      try {
        let path: string | null = m.attachment_path;
        if (file) {
          assertValidImageUpload(file);
          const prepared = await prepareUpload(file, "foto");
          assertChatImage(prepared.blob);
          path = chatAttachmentPath(m.thread_id, m.id, prepared.ext);
          const { error: upErr } = await supabase().storage.from(BUCKET).upload(path, prepared.blob, {
            contentType: prepared.contentType,
            upsert: false,
          });
          if (upErr && !/exists/i.test(upErr.message)) throw new Error(upErr.message);
        }
        await rpc("fa_chat_send", {
          p_id: m.id,
          p_thread_id: m.thread_id,
          p_body: m.body,
          p_attachment_path: path,
          p_context: m.context,
        });
        setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, attachment_path: path, pending: false, failed: false } : x)));
      } catch (e) {
        setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, pending: false, failed: true } : x)));
        throw e;
      }
    },
    [],
  );

  // Arquivos das mensagens que falharam, para o "tentar de novo".
  const filesRef = useRef(new Map<string, Blob>());

  const send = useCallback(
    async (rawBody: string, file?: Blob, employeeId?: string): Promise<void> => {
      if (!threadId) throw new Error("Chat indisponível");
      const body = normalizeChatBody(rawBody);
      const id = crypto.randomUUID();
      const optimistic: ChatMessage = {
        id,
        thread_id: threadId,
        sender_employee_id: employeeId ?? "",
        from_owner: false,
        body,
        attachment_path: null,
        context: getContextRef.current(),
        telegram_sent_at_ms: null,
        created_at_ms: Date.now(),
        pending: true,
      };
      if (file) filesRef.current.set(id, file);
      setMessages((cur) => mergeMessages(cur, [optimistic]).map((x) => (x.id === id ? { ...x, pending: true } : x)));
      await sendOne(optimistic, file);
      filesRef.current.delete(id);
    },
    [threadId, sendOne],
  );

  const retry = useCallback(
    async (id: string) => {
      const m = messages.find((x) => x.id === id);
      if (!m) return;
      setMessages((cur) => cur.map((x) => (x.id === id ? { ...x, pending: true, failed: false } : x)));
      await sendOne(m, filesRef.current.get(id)).catch(() => {});
    },
    [messages, sendOne],
  );

  return { threadId, messages, unread, loading, error, send, retry, markRead };
}

/** Quantidade de conversas com resposta do dono pendente, para a tela de PIN (sem login). */
export function useChatUnreadHint(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () => {
      rpc<number>("fa_chat_unread_hint")
        .then((v) => alive && setN(Number(v) || 0))
        .catch(() => {});
    };
    // Sem login não há Realtime aqui: o poll é o único mecanismo. Mantém a
    // ideia (o selo aparece em até 1 min) mas pausa com a janela escondida;
    // antes consultava a cada 30 s a noite toda, com o terminal ocioso.
    const stop = startVisiblePolling(run, 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return n;
}

/** URL assinada (5 min) de um anexo; a RLS do bucket decide quem pode. */
export async function chatAttachmentUrl(path: string): Promise<string | null> {
  const { data } = await supabase().storage.from(BUCKET).createSignedUrl(path, 300);
  return data?.signedUrl ?? null;
}
