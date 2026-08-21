// Linear accepts two kinds of credential on the same GraphQL endpoint, and they
// are NOT interchangeable in the header:
//   - OAuth2 access token (the multi-tenant path)  → "Bearer <token>"
//   - personal API key ("lin_api_…", the seeded /  → "<key>" with no scheme
//     self-serve path)
// Sending a personal key as a Bearer token authenticates as nobody and every
// mutation comes back "Authentication required". One helper so every caller
// (adapter, team picker) gets this right.

export function linearAuthHeader(token: string): string {
  return token.startsWith("lin_api_") ? token : `Bearer ${token}`;
}
