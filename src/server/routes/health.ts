import type { FastifyInstance } from "fastify";

/**
 * 存活探针：只回答「AutoRouter 进程是否正常启动并能响应请求」。
 *
 * 不探测上游、不检查模型可用性——那些由 RuntimeStatusService 的熔断状态机
 * 负责，探针再做一遍只会让探测耗时随 endpoint 数量线性增长。
 * 无需鉴权，否则探测方（launchd / 监控）得先拿到 gateway token。
 */
export async function registerHealthRoute(fastify: FastifyInstance) {
  fastify.get("/health", async () => ({ status: "ok" }));
}
