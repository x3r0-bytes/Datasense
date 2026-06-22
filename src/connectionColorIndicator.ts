import * as vscode from 'vscode';
import { ConnectionConfig } from './types';

/**
 * A predefined color entry with a human-readable name and hex value.
 */
export interface PredefinedColor {
  name: string;
  hex: string;
}

/**
 * The predefined color palette for connection identification.
 */
export const PREDEFINED_COLORS: PredefinedColor[] = [
  { name: 'Red', hex: '#FF0000' },
  { name: 'Orange', hex: '#FF8C00' },
  { name: 'Yellow', hex: '#FFD700' },
  { name: 'Green', hex: '#28A745' },
  { name: 'Blue', hex: '#007BFF' },
  { name: 'Purple', hex: '#6F42C1' },
];

/**
 * Validates a hex color string matches the #RRGGBB format.
 * Returns true if and only if the string is exactly 7 characters:
 * '#' followed by 6 hexadecimal digits (case-insensitive).
 */
export function isValidHexColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(value);
}

/**
 * Returns the predefined color name for a hex value (case-insensitive lookup),
 * or null if the hex value is a custom color not in the predefined palette.
 */
export function getColorName(hex: string): string | null {
  const upper = hex.toUpperCase();
  const match = PREDEFINED_COLORS.find(c => c.hex.toUpperCase() === upper);
  return match ? match.name : null;
}

/**
 * Formats the tooltip accessibility text for a color.
 * Returns the predefined color name (e.g., "Red") for palette colors,
 * or the hex value itself (e.g., "#A1B2C3") for custom colors.
 */
export function formatColorTooltip(hex: string): string {
  return getColorName(hex) ?? hex;
}


/**
 * Manages connection-scoped color indicators: a 2px top-border decoration
 * on all open SQL editors and status bar background coloring.
 * Listens to the onConnectionChanged event to apply/clear colors automatically.
 */
export class ConnectionColorIndicator implements vscode.Disposable {
  private tabDecoration: vscode.TextEditorDecorationType | undefined;
  private disposables: vscode.Disposable[] = [];
  private currentColor: string | undefined;

  constructor(onConnectionChanged: vscode.Event<ConnectionConfig | null>) {
    // Subscribe to connection changes
    this.disposables.push(
      onConnectionChanged((config) => {
        if (config && config.color) {
          this.applyColor(config.color);
        } else {
          this.clearColor();
        }
      })
    );

    // Re-apply decorations when new editors become visible
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        if (this.currentColor) {
          this.applyDecorationsToSqlEditors();
        }
      })
    );
  }

  /**
   * Apply the connection color as a 2px top-border decoration to all open SQL editors.
   * If color is undefined, clears all color indicators.
   */
  applyColor(color: string | undefined): void {
    if (!color) {
      this.clearColor();
      return;
    }

    this.currentColor = color;

    // Dispose previous decoration type if it exists
    if (this.tabDecoration) {
      this.tabDecoration.dispose();
    }

    // Create a new decoration type with 2px top border
    this.tabDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '2px 0 0 0',
      borderStyle: 'solid',
      borderColor: color,
    });

    // Apply to all currently visible SQL editors
    this.applyDecorationsToSqlEditors();
  }

  /**
   * Remove all color decorations and restore default appearance.
   */
  clearColor(): void {
    this.currentColor = undefined;

    if (this.tabDecoration) {
      this.tabDecoration.dispose();
      this.tabDecoration = undefined;
    }
  }

  /**
   * Disposes all resources held by this indicator.
   */
  dispose(): void {
    this.clearColor();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /**
   * Applies the current decoration to line 0 of all visible SQL editors.
   */
  private applyDecorationsToSqlEditors(): void {
    if (!this.tabDecoration) {
      return;
    }

    const sqlEditors = vscode.window.visibleTextEditors.filter(
      editor => editor.document.languageId === 'sql'
    );

    const line0Range = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);

    for (const editor of sqlEditors) {
      editor.setDecorations(this.tabDecoration, [line0Range]);
    }
  }
}
