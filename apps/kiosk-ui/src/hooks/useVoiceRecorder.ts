import { useCallback, useEffect, useRef, useState } from "react";
import { remainingSeconds } from "../lib/playgroundEval.js";

export interface RecordedAudio {
  audioBase64: string;
  mimeType: string;
}

export type VoiceState = "idle" | "recording";

/**
 * Gravação por voz (MediaRecorder) com contagem regressiva que para sozinha
 * em `maxSeconds`. Ideia portada do gravador de evolução da clínica, sem a
 * parte de análise: aqui só captura o áudio e entrega em base64 para a
 * transcrição. Mensagens de erro dizem o que fazer.
 */
export function useVoiceRecorder(opts: { maxSeconds: number; onAudio: (audio: RecordedAudio) => void }) {
  const { maxSeconds, onAudio } = opts;
  const [state, setState] = useState<VoiceState>("idle");
  const [secondsLeft, setSecondsLeft] = useState(maxSeconds);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onAudioRef = useRef(onAudio);
  onAudioRef.current = onAudio;

  const cleanup = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(
    () => () => {
      const r = recorderRef.current;
      if (r && r.state !== "inactive") {
        r.onstop = null;
        r.stop();
      }
      cleanup();
    },
    [cleanup],
  );

  const stop = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Este aparelho não grava áudio: digite a evolução.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        cleanup();
        setState("idle");
        setSecondsLeft(maxSeconds);
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        if (blob.size === 0) {
          setError("A gravação ficou vazia: grave de novo ou digite a evolução.");
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          const audioBase64 = result.split(",")[1] ?? "";
          if (!audioBase64) setError("Não foi possível ler a gravação: grave de novo ou digite a evolução.");
          else onAudioRef.current({ audioBase64, mimeType });
        };
        reader.onerror = () => setError("Não foi possível ler a gravação: grave de novo ou digite a evolução.");
        reader.readAsDataURL(blob);
      };
      const startedAt = Date.now();
      recorder.start();
      setState("recording");
      setSecondsLeft(maxSeconds);
      tickRef.current = setInterval(() => {
        const left = remainingSeconds(startedAt, Date.now(), maxSeconds);
        setSecondsLeft(left);
        if (left <= 0) recorder.state !== "inactive" && recorder.stop();
      }, 250);
    } catch (e) {
      cleanup();
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setError("Microfone bloqueado: permita o microfone no navegador.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setError("Não encontramos um microfone neste aparelho: digite a evolução.");
      } else {
        setError("Não foi possível usar o microfone: digite a evolução.");
      }
      setState("idle");
    }
  }, [cleanup, maxSeconds]);

  return { state, secondsLeft, error, start, stop, clearError: () => setError(null) };
}
