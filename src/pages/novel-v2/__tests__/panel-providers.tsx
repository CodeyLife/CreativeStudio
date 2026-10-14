import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import type { ReactNode } from "react";

/**
 * 面板测试的共享渲染包装。
 *
 * 为什么需要它：面板原先各自 `novelFetch` + `useState`，不需要任何 provider 就能 SSR 渲染。
 * 迁到共享数据层（`useNovelQuery` / `useNovelCommand`）之后，它们**真实地**依赖
 * `QueryClientProvider`——这不是测试的麻烦，而是"数据访问收归一层"的直接证据：
 * 以前每个面板自带一份取数逻辑，所以谁也不需要上下文。
 *
 * 抽成共享包装而不是在每个测试里各贴一遍，是为了让下一个新增的面板测试不会忘记它
 * （忘记的表现是 `No QueryClient set`，那是个与断言无关的噪声失败）。
 */
export function PanelProviders({ children }: { children: ReactNode }) {
  // 每个渲染一棵独立 client：SSR 下 effect 不跑，不会轮询；retry 关掉以免失败用例等待。
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, refetchInterval: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
        <App>{children}</App>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
