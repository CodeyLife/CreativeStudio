import { create } from "zustand";
import { persist } from "zustand/middleware";
import { prependWithCap } from "@/lib/cappedList";
import { deleteImagesQuietly } from "@/lib/imageStore";

/** 历史记录保留上限。TODO: 魔法值，后续如需按存储配额调整应提取为可配置项。 */
const MAX_HISTORY_ITEMS = 200;

export interface HistoryItem {
  id: string;
  type: "image" | "video";
  mode: "text2img" | "img2img";
  prompt: string;
  model: string;
  size: string;
  n: number;
  quality: string;
  /** 图片引用 id 数组（指向 IndexedDB 中的 Blob），单图仅 1 项 */
  imageIds: string[];
  status: "completed" | "failed";
  error?: string;
  createdAt: number;
}

interface HistoryState {
  items: HistoryItem[];
  add: (item: HistoryItem) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  /** 从指定历史项中移除单张图片；若该历史项变空则整体删除 */
  removeImage: (historyId: string, imageId: string) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      items: [],
      add: (item) =>
        set((s) => {
          const { kept, evicted } = prependWithCap(s.items, item, MAX_HISTORY_ITEMS);
          // 超出上限被淘汰的旧条目：清理其 IndexedDB 图片，避免孤儿 Blob
          if (evicted.length > 0) {
            deleteImagesQuietly(evicted.flatMap((h) => h.imageIds));
          }
          return { items: kept };
        }),
      remove: (id) =>
        set((s) => {
          const target = s.items.find((i) => i.id === id);
          if (target) deleteImagesQuietly(target.imageIds);
          return { items: s.items.filter((i) => i.id !== id) };
        }),
      removeMany: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const idSet = new Set(ids);
          const removed = s.items.filter((i) => idSet.has(i.id));
          deleteImagesQuietly(removed.flatMap((i) => i.imageIds));
          return { items: s.items.filter((i) => !idSet.has(i.id)) };
        }),
      removeImage: (historyId, imageId) =>
        set((s) => {
          const target = s.items.find((i) => i.id === historyId);
          if (!target) return s;
          deleteImagesQuietly([imageId]);
          const newImageIds = target.imageIds.filter((id) => id !== imageId);
          if (newImageIds.length === 0) {
            // 该历史项无图，整体删除
            return { items: s.items.filter((i) => i.id !== historyId) };
          }
          return {
            items: s.items.map((i) => (i.id === historyId ? { ...i, imageIds: newImageIds } : i)),
          };
        }),
      clear: () =>
        set((s) => {
          deleteImagesQuietly(s.items.flatMap((i) => i.imageIds));
          return { items: [] };
        }),
    }),
    { name: "ymcp-history" }
  )
);
