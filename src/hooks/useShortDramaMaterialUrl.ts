import { useEffect, useRef, useState } from "react";

/**
 * 把素材 Blob 转为可渲染的 objectURL，并在 blob 变化/组件卸载时 revoke 旧 URL，
 * 避免内存泄漏。供卡片级子组件内部调用（每实例一次，规避 hooks 循环调用限制）。
 */
export function useShortDramaMaterialUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const blobRef = useRef<Blob | undefined>(undefined);

  useEffect(() => {
    if (blob === blobRef.current) return;
    blobRef.current = blob;
    setUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return blob ? URL.createObjectURL(blob) : undefined;
    });
  }, [blob]);

  // 卸载时 revoke 最后一次 URL，并清空 blobRef.current——否则 StrictMode 挂载→卸载→
  // 重挂载时，重挂载的 effect 因 blob === blobRef.current 提前 return，objectURL 不被
  // 重新创建，预览永久空白（在 Dev 严格双挂载下必现）。
  useEffect(() => () => {
    blobRef.current = undefined;
    setUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return undefined;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return url;
}