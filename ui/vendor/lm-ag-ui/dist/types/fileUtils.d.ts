import { BinaryInputContent } from '@ag-ui/client';
/**
 * Read an array of File objects and return ag-ui BinaryInputContent parts
 * with inline base64-encoded data.
 */
export declare function filesToBinaryContent(files: File[]): Promise<BinaryInputContent[]>;
