import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteImagesQuietly } = vi.hoisted(() => ({ deleteImagesQuietly: vi.fn() }));
vi.mock("@/lib/imageStore", () => ({ deleteImagesQuietly }));

import { useHistoryStore, type HistoryItem } from "../history";

const MAX_HISTORY_ITEMS = 200;

function makeHistoryItem(id: string, imageIds: string[]): HistoryItem {
  return {
    id,
    type: "image",
    mode: "text2img",
    prompt: `prompt-${id}`,
    model: "test-model",
    size: "1024x1024",
    n: imageIds.length,
    quality: "standard",
    imageIds,
    status: "completed",
    createdAt: 0,
  };
}

beforeEach(() => {
  useHistoryStore.setState({ items: [] });
  deleteImagesQuietly.mockClear();
});

describe("history store capacity eviction", () => {
  it("cleans up the evicted entry's blobs once the cap is reached", () => {
    const existing = Array.from({ length: MAX_HISTORY_ITEMS }, (_, index) =>
      makeHistoryItem(`h${index}`, [`img-h${index}`]),
    );
    useHistoryStore.setState({ items: existing });

    useHistoryStore.getState().add(makeHistoryItem("new", ["img-new"]));

    const { items } = useHistoryStore.getState();
    expect(items).toHaveLength(MAX_HISTORY_ITEMS);
    expect(items[0].id).toBe("new");
    expect(items.some((item) => item.id === `h${MAX_HISTORY_ITEMS - 1}`)).toBe(false);
    expect(deleteImagesQuietly).toHaveBeenCalledTimes(1);
    expect(deleteImagesQuietly).toHaveBeenCalledWith([`img-h${MAX_HISTORY_ITEMS - 1}`]);
  });

  it("cleans up every blob of a multi-image evicted entry", () => {
    const existing = Array.from({ length: MAX_HISTORY_ITEMS }, (_, index) =>
      index === MAX_HISTORY_ITEMS - 1
        ? makeHistoryItem(`h${index}`, ["img-a", "img-b", "img-c"])
        : makeHistoryItem(`h${index}`, [`img-h${index}`]),
    );
    useHistoryStore.setState({ items: existing });

    useHistoryStore.getState().add(makeHistoryItem("new", ["img-new"]));

    expect(deleteImagesQuietly).toHaveBeenCalledWith(["img-a", "img-b", "img-c"]);
  });

  it("does not touch blobs of entries that remain in the list", () => {
    const existing = Array.from({ length: MAX_HISTORY_ITEMS }, (_, index) =>
      makeHistoryItem(`h${index}`, [`img-h${index}`]),
    );
    useHistoryStore.setState({ items: existing });

    useHistoryStore.getState().add(makeHistoryItem("new", ["img-new"]));

    const cleaned = deleteImagesQuietly.mock.calls.flat(2) as string[];
    expect(cleaned).not.toContain("img-h0");
    expect(cleaned).not.toContain("img-new");
  });

  it("evicts nothing while the list is below the cap", () => {
    useHistoryStore.setState({ items: [makeHistoryItem("h0", ["img-h0"])] });

    useHistoryStore.getState().add(makeHistoryItem("h1", ["img-h1"]));

    expect(useHistoryStore.getState().items.map((item) => item.id)).toEqual(["h1", "h0"]);
    expect(deleteImagesQuietly).not.toHaveBeenCalled();
  });
});
