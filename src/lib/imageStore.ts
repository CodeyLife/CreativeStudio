import { get, set, del, delMany, clear } from "idb-keyval";
import { createRepairingStore } from "./indexedDbStore";

/**
 * IndexedDB 图片存储
 *
 * 设计目的：替代 localStorage 存放生图历史 / 素材库的图片数据。
 * localStorage 5MB 配额极易被 base64 图片撑爆，导致刷新后历史记录丢失。
 * IndexedDB 容量数百 MB 起步，原生支持 Blob 存储（无 base64 膨胀）。
 *
 * 数据模型：key = imageId（"img-{timestamp}-{rand}"），value = Blob。
 * zustand store 中只保存 imageId 引用，图片本体在此处单独分条存储。
 */

const imageStore = createRepairingStore("ymcp-image-db", "images");

/** 生成 imageId */
function genId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 存入一张图片，返回 imageId */
export async function setImage(blob: Blob): Promise<string> {
  const id = genId();
  await set(id, blob, imageStore);
  return id;
}

/** 根据 imageId 取回图片 Blob */
export async function getImage(id: string): Promise<Blob | undefined> {
  return await get<Blob>(id, imageStore);
}

/** 删除单张图片 */
export async function deleteImage(id: string): Promise<void> {
  await del(id, imageStore);
}

/** 批量删除图片 */
export async function deleteManyImages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await delMany(ids, imageStore);
}

/** 清空所有图片（用于清空历史 / 素材库时） */
export async function clearAllImages(): Promise<void> {
  await clear(imageStore);
}

/**
 * 清理一批图片 Blob，失败只留痕、不抛出。
 *
 * 调用点都位于 zustand 的同步 set 回调里，无法 await；删除失败（例如其他标签页
 * 占用、配额或事务异常）不应阻断元数据更新。但失败必须可见，否则「元数据已删、
 * Blob 仍在」的孤儿数据会无声累积——这正是历史/素材截断路径曾经的形态。
 */
export function deleteImagesQuietly(ids: readonly string[]): void {
  const targets = [...new Set(ids)].filter((id) => id.length > 0);
  if (targets.length === 0) return;
  deleteManyImages(targets).catch((error: unknown) => {
    console.warn("[imageStore] 图片 Blob 清理失败，可能产生孤儿数据", targets, error);
  });
}
