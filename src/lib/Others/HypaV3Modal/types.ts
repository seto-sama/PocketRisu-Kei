export interface SummaryItemState {
  originalRef: HTMLTextAreaElement | null;
  translationRef: HTMLTextAreaElement | null;
  rerolledTranslationRef: HTMLTextAreaElement | null;
  chatMemoRefs: Array<HTMLButtonElement | null>;
}

export interface ExpandedMessage {
  summaryIndex: number;
  selectedChatMemo: string | null;
  isTranslating: boolean;
  translation: string | null;
  translationRef: HTMLTextAreaElement | null;
}

export type ExpandedMessageState = ExpandedMessage | null;

export interface SearchSession {
  query: string;
  results: SearchResult[];
  currentResultIndex: number;
  requestedSearchFromIndex: number;
  isNavigating: boolean;
}

export type SearchState = SearchSession | null;

export type SearchResult = SummarySearchResult | ChatMemoSearchResult;

export interface SummarySearchResult {
  type: "summary";
  summaryIndex: number;
  start: number;
  end: number;
}

export interface ChatMemoSearchResult {
  type: "chatmemo";
  summaryIndex: number;
  memoIndex: number;
}

export interface BulkResummaryState {
    isProcessing: boolean;
    result: string | null;
    selectedIndices: number[];
    mergedChatMemos: string[];
    isTranslating: boolean;
    translation: string | null;
}

// Category Management Types
export interface Category {
    id: string;
    name: string;
}

export interface CategoryManagerState {
    isOpen: boolean;
    editingCategory: Category | null;
}

// Bulk Edit Types
export interface BulkEditState {
    isEnabled: boolean;
    selectedSummaries: Set<number>;
    selectedCategory: string;
    bulkSelectInput: string;
}

// Filter States
export interface FilterState {
    showImportantOnly: boolean;
    selectedCategoryFilter: string;
}

export const DISPLAY_MODE = {
  All: "All",
  Range: "Range",
  Recent: "Recent",
} as const;

export type DisplayMode = (typeof DISPLAY_MODE)[keyof typeof DISPLAY_MODE];
