declare module "parquetjs-lite" {
  export class ParquetSchema {
    public constructor(schemaDefinition: Record<string, unknown>);
  }

  export class ParquetWriter {
    public static openFile(
      schema: ParquetSchema,
      path: string,
      options?: Record<string, unknown>
    ): Promise<ParquetWriter>;
    public appendRow(row: Record<string, unknown>): Promise<void>;
    public close(): Promise<void>;
  }

  export class ParquetReader {
    public static openFile(path: string): Promise<ParquetReader>;
    public getCursor(columns?: string[]): {
      next(): Promise<Record<string, unknown> | null>;
    };
    public close(): Promise<void>;
  }

  const parquet: {
    ParquetSchema: typeof ParquetSchema;
    ParquetWriter: typeof ParquetWriter;
    ParquetReader: typeof ParquetReader;
  };

  export default parquet;
}
