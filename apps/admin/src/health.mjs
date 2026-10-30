export function isHealthyResponse(body) {
  return (
    body !== null &&
    typeof body === 'object' &&
    body.data?.status === 'ok' &&
    typeof body.requestId === 'string' &&
    body.requestId.length > 0
  );
}
