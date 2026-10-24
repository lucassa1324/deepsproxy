export interface LocalApiUrls {
  port: number;
  gatewayPort: number;
  proxyUrl: string;
  proxyLocalhostUrl: string;
  gatewayUrl: string;
  gatewayLocalhostUrl: string;
  requestOrigin: string | null;
}

export function localApiUrls(origin?: string | null): LocalApiUrls {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
  const gatewayPort = process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT, 10) : 3006;
  return {
    port,
    gatewayPort,
    proxyUrl: `http://127.0.0.1:${port}`,
    proxyLocalhostUrl: `http://localhost:${port}`,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}/v1`,
    gatewayLocalhostUrl: `http://localhost:${gatewayPort}/v1`,
    requestOrigin: origin || null,
  };
}
