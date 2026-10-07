interface Window {
  /** Optional UMD export from the versioned public/qrcode-generator.js asset. */
  qrcode?: (typeNumber: number, correction: "L" | "M" | "Q" | "H") => {
    addData(data: string): void;
    make(): void;
    createSvgTag(options: { cellSize: number; margin: number }): string;
  };
}
