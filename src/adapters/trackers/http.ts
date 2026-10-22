export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type HttpTransport = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (url, request = {}) =>
  fetch(url, {
    ...(request.method ? { method: request.method } : {}),
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.body ? { body: request.body } : {}),
  });
