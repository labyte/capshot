import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** 与 apps/desktop 命令面唯一的调用入口。二进制响应（tauri::ipc::Response）落到 ArrayBuffer。 */
export const invoke = <T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> => tauriInvoke<T>(cmd, args);

export function u8ToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

export function fmtBytes(n: number): string {
  return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(0) + " KB";
}

export function bytesToBlobUrl(buf: ArrayBuffer, type: string): string {
  return URL.createObjectURL(new Blob([buf], { type }));
}
