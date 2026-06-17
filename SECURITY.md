# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in ctrodb, please:

1. **Do not** open a public issue.
2. Send details to **[security@ctrodb.dev](mailto:security@ctrodb.dev)**.
3. Include a description of the vulnerability, steps to reproduce, and potential impact.

You will receive a response within **48 hours**. We will work with you to understand the issue and coordinate a fix.

## Scope

This security policy covers the ctrodb npm package, its source code, and the official website at [ctrodb.vercel.app](https://ctrodb.vercel.app).

## Best Practices

- Always use the latest version of ctrodb.
- Validate and sanitize user input before storing in the database.
- Do not expose internal database state to untrusted clients.
- Use the schema validation feature to enforce data integrity.
