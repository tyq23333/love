/** Claude / fal 等海外 API 用的代理（勿用全局 HTTPS_PROXY，否则微信也会走代理） */
export function anthropicProxyUrl(): string | undefined {
  return (
    process.env["ANTHROPIC_PROXY"]?.trim() ||
    process.env["HTTPS_PROXY"]?.trim() ||
    process.env["HTTP_PROXY"]?.trim() ||
    undefined
  );
}

/** axios 禁用环境变量代理（微信等国内服务必须直连） */
export const axiosDirect = { proxy: false as const };
