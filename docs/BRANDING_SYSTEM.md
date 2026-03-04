# Project Branding System

This project uses an automated branding system to maintain separate identities for public releases and internal development.

## Quick Start

```bash
# Development with branding
npm run tauri:dev:internal    # Development with internal branding (Bodhi)
npm run tauri:dev:public      # Development with public branding (Bamboo)

# Build for internal development
npm run build:internal
npm run tauri:build:internal

# Build for public release
npm run build:public
npm run tauri:build:public
```

## Branding Targets

### Internal (default)
- **Product Name**: Bodhi
- **Package Name**: bodhi
- **Window Title**: Bodhi
- **System Prompt**: "You are Bodhi"

**Use for**:
- Local development
- Internal testing
- Development builds

### Public
- **Product Name**: Bamboo
- **Package Name**: bamboo
- **Window Title**: Bamboo
- **System Prompt**: "You are Bamboo"

**Use for**:
- GitHub releases
- Public distribution
- Production builds

## Available Commands

### Rebranding Commands
```bash
# Switch brand without building
npm run rebrand:internal     # Switch to internal branding
npm run rebrand:public       # Switch to public branding
```

### Build Commands
```bash
# Frontend-only builds
npm run build:internal       # Build frontend with internal branding
npm run build:public         # Build frontend with public branding

# Full Tauri application builds
npm run tauri:build:internal # Build Tauri app with internal branding
npm run tauri:build:public   # Build Tauri app with public branding
```

### Development Commands
```bash
# Development with hot reload
npm run tauri:dev:internal   # Dev mode with internal branding
npm run tauri:dev:public     # Dev mode with public branding
```

## Branding Targets

### Internal (default)
- **Product Name**: Bodhi
- **Package Name**: bodhi
- **Window Title**: Bodhi
- **System Prompt**: "You are Bodhi"

**Use for**:
- Local development
- Internal testing
- Development builds

### Public
- **Product Name**: Bamboo
- **Package Name**: bamboo
- **Window Title**: Bamboo
- **System Prompt**: "You are Bamboo"

**Use for**:
- GitHub releases
- Public distribution
- Production builds

## How It Works

The `scripts/rebrand.cjs` script automatically updates:

1. **package.json** - Package name
2. **src-tauri/tauri.conf.json** - Product name and window title
3. **index.html** - HTML title
4. **src/pages/ChatPage/utils/defaultSystemPrompts.ts** - System prompt name and content
5. **src/pages/ChatPage/components/__tests__/SystemPromptSelector.test.tsx** - Test fixtures

### Brand Info File

After running the script, a `.brand-info.json` file is generated with current branding details:

```json
{
  "target": "internal",
  "brand": {
    "productName": "Bodhi",
    "packageName": "bodhi",
    ...
  },
  "updatedAt": "2026-03-08T..."
}
```

This file is excluded from Git (`.gitignore`) and is for local reference only.

## Manual Usage

You can run the rebranding script directly:

```bash
# Rebrand to internal
node scripts/rebrand.cjs --target=internal

# Rebrand to public
node scripts/rebrand.cjs --target=public
```

## Customizing Brands

Edit `scripts/rebrand.cjs` and modify the `BRANDS` object:

```javascript
const BRANDS = {
  public: {
    productName: 'Bamboo',
    windowTitle: 'Bamboo',
    packageName: 'bamboo',
    htmlTitle: 'Bamboo',
    systemPromptName: 'Bamboo',
    systemPromptContent: 'You are Bamboo',
  },
  internal: {
    productName: 'Bodhi',
    windowTitle: 'Bodhi',
    packageName: 'bodhi',
    htmlTitle: 'Bodhi',
    systemPromptName: 'Default',
    systemPromptContent: 'You are Bodhi',
  },
};
```

## CI/CD Integration

For automated builds, use the appropriate build command:

```yaml
# GitHub Actions example
- name: Build for public release
  run: npm run tauri:build:public

# Or for internal testing
- name: Build for internal testing
  run: npm run tauri:build:internal
```

## Important Notes

1. **Always use the npm scripts** (`npm run build:*`) instead of direct build commands
2. **The branding script modifies files in place** - Make sure to commit or stash changes first
3. **Test both targets** before release to ensure branding is correct
4. **The .brand-info.json file is auto-generated** - Don't commit it to Git

## Troubleshooting

### Files not updating
- Make sure you're in the project root directory
- Check that all target files exist and are writable
- Look for error messages in the script output

### Wrong branding in built app
- Run `npm run rebrand:*` before building
- Clear build cache (`rm -rf dist` and `rm -rf src-tauri/target`)
- Rebuild after rebranding

### Script errors
- Ensure Node.js is installed (v16+)
- Check that the script has proper permissions
- Verify JSON files are valid and properly formatted
