# Bamboo - GitHub Copilot Chat Desktop

Bamboo is a native desktop application for GitHub Copilot Chat, built with **Tauri** (Rust backend) and **React/TypeScript** (frontend). It provides a focused, AI-assisted coding experience with autonomous agent capabilities and an intuitive chat interface.

## Features

### Core Chat
- **Interactive Chat Interface** - Clean, responsive chat window with real-time streaming
- **Rich Markdown Rendering** - Formatted text, lists, links, and Mermaid diagrams
- **Syntax Highlighting** - Code snippets with accurate language detection
- **Cross-Platform** - Native experience on macOS, Windows, and Linux

### AI Agent System
- **Autonomous Tool Usage** - LLM can invoke tools to accomplish tasks
- **Agent Loop Orchestration** - Backend manages multi-step execution
- **Approval Gates** - Sensitive operations require explicit user approval
- **Error Recovery** - Intelligent retry with LLM feedback
- **Timeout Protection** - Safeguards against runaway loops
- **Multi-LLM Support** - GitHub Copilot, OpenAI, Anthropic Claude, Google Gemini

### User Workflows
- **Explicit Control** - User-initiated workflows for complex operations
- **Form-Based UI** - Parameter input with validation
- **Category Organization** - Grouped by functionality (general, file operations, system)
- **Safety Warnings** - Clear prompts for destructive operations

### Developer Experience
- **System Prompt Management** - Create and manage custom prompts
- **Context Persistence** - Backend-managed chat history
- **File References** - Drag/drop or `@mention` files
- **Virtualized Rendering** - Smooth performance with large conversations

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Ant Design 5, Vite |
| Backend | Rust, Tauri, bamboo-agent crate |
| State | Zustand (UI), custom hooks (chat) |
| Testing | Vitest (frontend), cargo test (backend) |

## Architecture

Bamboo uses an **embedded architecture** where the bamboo-agent HTTP server runs directly within the Tauri application process:

```
┌──────────────────────────┐
│  Tauri Desktop App       │
│  ├── Frontend (React)    │
│  ├── HTTP Server :8080   │  ← Embedded
│  └── bamboo-agent        │
└──────────────────────────┘
```

**Benefits**:
- Single process (simpler than sidecar)
- Faster startup
- Lower resource usage
- Easier debugging
- Direct access to agent internals

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (LTS recommended)
- [Rust](https://rustup.rs/)
- GitHub Copilot API token (or other LLM provider token)

### Installation

```bash
# Clone the repository
git clone https://github.com/bigduu/Bodhi.git
cd Bodhi

# Install shell dependencies
cd bodhi && npm install

# Install frontend dependencies
cd lotus && npm install

# Configure API token
# Create a .token file in src-tauri/ with your GitHub Copilot token
```

### Development

```bash
# Start Tauri shell + frontend
cd bodhi && npm run tauri:dev

# Run frontend tests
cd bodhi && npm run test

# Format frontend code
cd bodhi && npm run format
```

### Build

```bash
# Create production build
cd bodhi && npm run tauri:build
```

## Project Structure

```
bamboo/
├── src/                    # Frontend React application
│   ├── pages/             # Page components (Chat, Settings, Spotlight)
│   ├── app/               # Root app component
│   └── services/          # Shared services
├── src-tauri/             # Tauri application
│   ├── src/
│   │   ├── embedded/      # Embedded web service manager
│   │   ├── command/       # Tauri commands
│   │   ├── process/       # Process registry
│   │   └── ...
│   └── Cargo.toml         # bamboo-agent dependency
├── ../lotus/e2e/          # End-to-end tests (Playwright)
└── docs/                  # Documentation
```

## Dependencies

### Key Dependencies
- **[bamboo-agent](https://crates.io/crates/bamboo-agent)** - AI agent backend framework (v0.1.0)
  - Multi-LLM provider support (Copilot, OpenAI, Claude, Gemini)
  - 24 built-in tools for file operations
  - Session management
  - Workflow system

## Deployment Modes

Bamboo supports multiple deployment modes:

### Desktop Mode (Tauri + Embedded)
- Single process architecture
- Embedded HTTP server on `127.0.0.1:8080`
- Native desktop features
- Use: `cd bodhi && npm run tauri:dev` or `cd bodhi && npm run tauri:build`

### Browser Development Mode
- Frontend served by Vite dev server (port 1420)
- Backend runs as standalone process
- Use: `cargo run --manifest-path ../bamboo/Cargo.toml --bin bamboo -- serve --port 9562 --bind 127.0.0.1 --data-dir /tmp/bamboo-data`

## Documentation

Comprehensive documentation is organized in the `docs/` directory:

- **[Architecture](docs/architecture/)** - System design and architecture
- **[Development](docs/development/)** - Development guidelines
- **[Extension System](docs/extension-system/)** - Tool creation and registration
- **[Testing](docs/testing/)** - Testing strategies

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run `npm run format` before committing
5. Push and open a Pull Request

### Commit Convention

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Test changes
- `chore:` Build/config changes

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Note**: Version 2.0+ introduces backend-managed chat context. See the [migration guide](docs/architecture/context-manager-migration.md) if upgrading from earlier versions.
