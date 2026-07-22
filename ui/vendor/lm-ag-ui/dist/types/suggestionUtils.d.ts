import { Suggestion } from './index';
/** Separator between the category and the suggestion text within a stored suggestion. */
export declare const SUGGESTION_CATEGORY_SEPARATOR = "|";
export interface CategorizedSuggestion {
    /** Suggestion text with the `Category|` prefix removed, trimmed. */
    text: string;
    isPriority: boolean;
}
export interface SuggestionGroup {
    /** Trimmed category label. */
    category: string;
    suggestions: CategorizedSuggestion[];
}
/**
 * Group suggestions by their leading `Category|` prefix, preserving the
 * first-seen order of both categories and the items within each. Input is
 * already priority-ordered by the backend, so priority items surface first
 * naturally — no extra sort is applied.
 *
 * Entries with no separator, an empty category, or empty text are dropped
 * (they cannot form a labeled group). Returns `[]` when nothing is valid.
 */
export declare function groupSuggestionsByCategory(suggestions: Suggestion[] | null | undefined): SuggestionGroup[];
