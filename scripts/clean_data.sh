#!/bin/bash

# Clean all historical chat data to fix serialization errors
# This script removes old data that uses PascalCase state names (e.g., "Idle")
# The new backend expects snake_case state names (e.g., "idle")

set -e

echo "🧹 Cleaning historical chat data..."
echo ""

# Find the data directory
# Default location for Tauri app data
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    APP_DATA_DIR="$HOME/Library/Application Support/com.bodhi.app"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    APP_DATA_DIR="$HOME/.local/share/com.bodhi.app"
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    # Windows
    APP_DATA_DIR="$APPDATA/com.bodhi.app"
else
    echo "❌ Unsupported OS: $OSTYPE"
    exit 1
fi

echo "📁 App data directory: $APP_DATA_DIR"
echo ""

# Check if directory exists
if [ ! -d "$APP_DATA_DIR" ]; then
    echo "✅ No data directory found. Nothing to clean."
    exit 0
fi

# Backup data before deletion (optional)
BACKUP_DIR="$APP_DATA_DIR.backup.$(date +%Y%m%d_%H%M%S)"
echo "💾 Creating backup at: $BACKUP_DIR"
cp -r "$APP_DATA_DIR" "$BACKUP_DIR"
echo "✅ Backup created"
echo ""

# Remove conversations directory
CONVERSATIONS_DIR="$APP_DATA_DIR/conversations"
if [ -d "$CONVERSATIONS_DIR" ]; then
    echo "🗑️  Removing conversations directory..."
    rm -rf "$CONVERSATIONS_DIR"
    echo "✅ Conversations removed"
else
    echo "ℹ️  No conversations directory found"
fi

# Remove sessions directory
SESSIONS_DIR="$APP_DATA_DIR/sessions"
if [ -d "$SESSIONS_DIR" ]; then
    echo "🗑️  Removing sessions directory..."
    rm -rf "$SESSIONS_DIR"
    echo "✅ Sessions removed"
else
    echo "ℹ️  No sessions directory found"
fi

echo ""
echo "✅ Data cleanup complete!"
echo ""
echo "📝 Summary:"
echo "   - Backup created at: $BACKUP_DIR"
echo "   - Conversations removed: $CONVERSATIONS_DIR"
echo "   - Sessions removed: $SESSIONS_DIR"
echo ""
echo "🚀 You can now restart the application with clean data."
echo ""
echo "⚠️  If you need to restore the backup:"
echo "   rm -rf '$APP_DATA_DIR'"
echo "   mv '$BACKUP_DIR' '$APP_DATA_DIR'"
