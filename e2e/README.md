# E2E Testing

End-to-end testing infrastructure for Bodhi using Playwright.

## Quick Start

1. Install dependencies:
   ```bash
   cd e2e
   yarn install
   npx playwright install
   ```

2. Start the backend:
   ```bash
   cargo run -p web_service_standalone -- --port 9562 --data-dir /tmp/test-data
   ```

3. Run tests:
   ```bash
   # If backend is running on port 9562
   yarn test

   # Browser mode (frontend on port 1420)
   yarn test:browser

   # Docker mode
   yarn test:docker

   # Auto-start backend
   yarn test:with-server
   ```

## Test Scripts

| Script | Description |
|--------|-------------|
| `yarn test` | Run tests (requires backend running on :9562) |
| `yarn test:browser` | Test against browser dev server (:1420) |
| `yarn test:docker` | Test against Docker container (:9562) |
| `yarn test:with-server` | Auto-start backend and run tests |
| `yarn test:ui` | Run tests in interactive UI mode |
| `yarn test:debug` | Run tests with debugger |
| `yarn test:report` | Show HTML test report |

## Configuration

### Environment Variables

- `E2E_BASE_URL` - Base URL for tests (default: http://localhost:9562)
- `E2E_START_SERVER` - Command to start server (optional)
- `CI` - Set to enable CI mode (retries, screenshots)

### Examples

```bash
# Test against browser dev server
E2E_BASE_URL=http://localhost:1420 yarn test

# Test against custom backend
E2E_BASE_URL=http://localhost:9000 yarn test

# Auto-start backend before tests
E2E_START_SERVER="cargo run -p web_service_standalone -- --port 9562" yarn test
```

## Test Structure

```
e2e/
├── tests/
│   ├── setup-flow.spec.ts        # Setup wizard tests
│   ├── chat-functionality.spec.ts # Chat operations
│   ├── workflows.spec.ts         # Workflow management
│   ├── keyword-masking.spec.ts   # Keyword masking
│   ├── settings.spec.ts          # Settings management
│   └── modes/
│       ├── browser-mode.spec.ts  # Browser-specific tests
│       ├── desktop-mode.spec.ts  # Desktop-only features
│       └── docker-mode.spec.ts   # Docker deployment tests
├── fixtures/                     # Test data files
├── utils/
│   └── api-helpers.ts           # API utilities
├── playwright.config.ts         # Playwright configuration
├── global-setup.ts              # Global test setup
└── global-teardown.ts           # Global test teardown
```

## Writing Tests

### Basic Test

```typescript
import { test, expect } from '@playwright/test';

test('should do something', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-testid="button"]');
  await expect(page.locator('[data-testid="result"]')).toBeVisible();
});
```

### Using API Helpers

```typescript
import { createTestWorkflow, cleanupTestData } from '../utils/api-helpers';

test('workflow test', async ({ page, request }) => {
  // Setup
  await createTestWorkflow(request, 'test', '# Content');

  // Test
  await page.goto('/settings/workflows');
  await expect(page.locator('text=test')).toBeVisible();

  // Cleanup is handled automatically by globalTeardown
});
```

## API Endpoints

Tests use these backend endpoints:

- `GET /v1/health` - Health check
- `GET /bamboo/workflows` - List workflows
- `POST /bamboo/workflows` - Create workflow
- `DELETE /bamboo/workflows/{name}` - Delete workflow
- `GET /bamboo/setup/status` - Setup status
- `POST /bamboo/setup/complete` - Mark setup complete

## Debugging

### UI Mode
```bash
yarn test:ui
```

### Debug Mode
```bash
yarn test:debug
```

### View Report
```bash
yarn test:report
```

## Troubleshooting

### Backend not running
```
❌ Backend health check failed
```
Start the backend:
```bash
cargo run -p web_service_standalone -- --port 9562 --data-dir /tmp/test-data
```

### Port already in use
Change the port:
```bash
cargo run -p web_service_standalone -- --port 9563 --data-dir /tmp/test-data
E2E_BASE_URL=http://localhost:9563 yarn test
```

### Tests timeout
Increase timeout in `playwright.config.ts`:
```typescript
use: {
  actionTimeout: 30000,
  navigationTimeout: 60000,
}
```

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [API Reference](https://playwright.dev/docs/api/class-page)
