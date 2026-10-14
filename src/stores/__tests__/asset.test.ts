import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteImagesQuietly } = vi.hoisted(() => ({ deleteImagesQuietly: vi.fn() }));
vi.mock("@/lib/imageStore", () => ({ deleteImagesQuietly }));

import { useAssetStore, type AssetItem } from "../asset";

const MAX_ASSET_ITEMS = 500;

function makeAssetItem(id: string, imageId: string): AssetItem {
  return {
    id,
    name: `asset-${id}`,
    type: "image",
    imageId,
    tags: [],
    metadata: {},
    createdAt: 0,
  };
}

beforeEach(() => {
  useAssetStore.setState({ items: [], groups: [] });
  deleteImagesQuietly.mockClear();
});

describe("asset store capacity eviction", () => {
  it("cleans up the evicted entry's blob once the cap is reached", () => {
    const existing = Array.from({ length: MAX_ASSET_ITEMS }, (_, index) =>
      makeAssetItem(`a${index}`, `img-a${index}`),
    );
    useAssetStore.setState({ items: existing, groups: [] });

    useAssetStore.getState().add(makeAssetItem("new", "img-new"));

    const { items } = useAssetStore.getState();
    expect(items).toHaveLength(MAX_ASSET_ITEMS);
    expect(items[0].id).toBe("new");
    expect(items.some((item) => item.id === `a${MAX_ASSET_ITEMS - 1}`)).toBe(false);
    expect(deleteImagesQuietly).toHaveBeenCalledTimes(1);
    expect(deleteImagesQuietly).toHaveBeenCalledWith([`img-a${MAX_ASSET_ITEMS - 1}`]);
  });

  it("does not touch blobs of entries that remain in the list", () => {
    const existing = Array.from({ length: MAX_ASSET_ITEMS }, (_, index) =>
      makeAssetItem(`a${index}`, `img-a${index}`),
    );
    useAssetStore.setState({ items: existing, groups: [] });

    useAssetStore.getState().add(makeAssetItem("new", "img-new"));

    const cleaned = deleteImagesQuietly.mock.calls.flat(2) as string[];
    expect(cleaned).not.toContain("img-a0");
    expect(cleaned).not.toContain("img-new");
  });

  it("evicts nothing while the list is below the cap", () => {
    useAssetStore.setState({ items: [makeAssetItem("a0", "img-a0")], groups: [] });

    useAssetStore.getState().add(makeAssetItem("a1", "img-a1"));

    expect(useAssetStore.getState().items.map((item) => item.id)).toEqual(["a1", "a0"]);
    expect(deleteImagesQuietly).not.toHaveBeenCalled();
  });
});
