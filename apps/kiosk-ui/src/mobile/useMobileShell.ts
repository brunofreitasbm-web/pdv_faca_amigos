import { useCallback, useEffect, useState } from "react";
import { useAppState } from "../state/AppState.js";

const PHONE_MAX_WIDTH = 640;

/**
 * Reconhece automaticamente se o dispositivo atual é celular ou desktop/totem.
 * - Celular: smartphone (Android/iPhone) ou tela estreita (<= 640px)
 * - Desktop: computadores, notebooks, totens e tablets de balcão
 */
export function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mobile") === "1" || params.get("mobile") === "true") return true;
    if (params.get("desktop") === "1" || params.get("desktop") === "true") return false;
  } catch {}

  const ua = navigator.userAgent || "";
  const isMobileUA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isPhoneWidth = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`).matches;

  if (isMobileUA && window.innerWidth <= 768) {
    return true;
  }

  return isPhoneWidth;
}

export interface MobileShellState {
  /** A casca mobile deve ser renderizada agora. */
  active: boolean;
  /** O aparelho foi identificado como celular. */
  isPhone: boolean;
  /** Sai para as telas completas. */
  useFullVersion: () => void;
  /** Volta para a casca mobile. */
  useMobileVersion: () => void;
}

/**
 * A casca mobile mostra receita do dia, ocupação e "Trocar de unidade". O
 * Avaliador é o login do tablet fixo do playground: só a aba Avaliações, nada
 * financeiro. Um tablet pequeno ou em pé cai na regra de celular acima, então
 * o papel precisa excluir a casca por conta própria, qualquer que seja o aparelho.
 */
export function mobileShellAllowedFor(role: string | null | undefined): boolean {
  return role !== "AVALIADOR";
}

export function useMobileShell(): MobileShellState {
  const { employee } = useAppState();
  const allowed = mobileShellAllowedFor(employee?.role);
  const [isPhone, setIsPhone] = useState(isMobileDevice);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);
    const onChange = () => setIsPhone(isMobileDevice());
    mql.addEventListener("change", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);

  const useFullVersion = useCallback(() => {
    setIsPhone(false);
  }, []);

  const useMobileVersion = useCallback(() => {
    setIsPhone(true);
  }, []);

  return { active: isPhone && allowed, isPhone, useFullVersion, useMobileVersion };
}
