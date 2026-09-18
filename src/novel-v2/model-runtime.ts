import { ModelConfigStore } from "./model-config-store";
import { RoutedModelGateway } from "./model-gateway";
import type { ModelRuntimeRepositoryAccess } from "./repository-capabilities";
import type { ObjectStoreAdapter } from "./object-store";

export async function createRuntimeModelGateway(repository: ModelRuntimeRepositoryAccess, objects?: ObjectStoreAdapter) {
  const configStore = new ModelConfigStore();
  await configStore.load();
  await repository.projectModelRoutingConfig(configStore.getConfig(), configStore.getSnapshot());
  const gateway = new RoutedModelGateway(
    configStore,
    (audit) => repository.recordModelInvocation(audit),
    // OR-D3（E5）：采样判定与物化在留痕本体 recordPromptExecution 内（最低共享层，
    // 消费面无法绕过），这里只把网关留痕回调接到 repository。
    objects ? (execution) => repository.recordPromptExecution(execution, objects) : undefined,
    // OR-D2（product-audit-20260910 E5）：内容寻址嵌入缓存短路同文本重复 embed。
    repository,
  );
  return { configStore, gateway };
}
