import React from 'react';

interface HighlightedTextProps {
    text: string;
    searchQuery: string;
    /** Additional terms to highlight (e.g., stemmed terms from API) */
    searchTerms?: string[];
    isCurrentMatch?: boolean;
    matchRef?: React.RefObject<HTMLSpanElement>;
    /** Which occurrence within this text block is current (0-indexed).
     *  When undefined and isCurrentMatch=true, ALL matches are orange (backward-compatible).
     *  When defined, only that specific occurrence is orange. */
    currentMatchOccurrence?: number;
}

/**
 * HighlightedText - Renders text with search matches highlighted.
 * Highlights both the original searchQuery and any additional searchTerms.
 * This supports PostgreSQL stemming where "subtract" matches "subtraction".
 */
export const HighlightedText: React.FC<HighlightedTextProps> = ({
    text,
    searchQuery,
    searchTerms = [],
    isCurrentMatch = false,
    matchRef,
    currentMatchOccurrence,
}) => {
    // Build list of all terms to highlight (original query + stemmed terms)
    const allTerms = new Set<string>();
    if (searchQuery.trim()) {
        allTerms.add(searchQuery.trim().toLowerCase());
    }
    (searchTerms || []).forEach(term => {
        if (term.trim()) {
            allTerms.add(term.trim().toLowerCase());
        }
    });

    if (allTerms.size === 0 || !text) {
        return <>{text}</>;
    }

    // Build regex that matches any of the terms
    const termsArray = Array.from(allTerms);
    const regexPattern = termsArray.map(term => escapeRegExp(term)).join('|');
    const regex = new RegExp(`(${regexPattern})`, 'gi');
    const parts = text.split(regex);

    let matchCount = 0;

    return (
        <>
            {parts.map((part, index) => {
                const isMatch = termsArray.some(term => part.toLowerCase() === term);
                if (isMatch) {
                    const thisOccurrence = matchCount;
                    matchCount++;
                    // When currentMatchOccurrence is defined, only that occurrence is orange.
                    // When undefined, all matches are orange if isCurrentMatch (backward-compatible).
                    const isCurrent = isCurrentMatch && (
                        currentMatchOccurrence === undefined || thisOccurrence === currentMatchOccurrence
                    );
                    return (
                        <mark
                            key={index}
                            ref={isCurrent && (currentMatchOccurrence === undefined ? thisOccurrence === 0 : true) ? matchRef : undefined}
                            className={`px-0.5 rounded ${isCurrent ? 'bg-orange-400 text-white' : 'bg-yellow-200 text-inherit'}`}
                        >
                            {part}
                        </mark>
                    );
                }
                return <span key={index}>{part}</span>;
            })}
        </>
    );
};

/**
 * Escapes special regex characters in a string.
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Counts the number of matches of searchQuery in text.
 */
export function countMatches(text: string, searchQuery: string): number {
    if (!searchQuery.trim() || !text) return 0;
    const regex = new RegExp(escapeRegExp(searchQuery), 'gi');
    const matches = text.match(regex);
    return matches ? matches.length : 0;
}

/**
 * Checks if text contains the search query or any of the additional terms (case-insensitive).
 */
export function textContains(text: string, searchQuery: string, searchTerms?: string[]): boolean {
    if (!text) return false;
    const lowerText = text.toLowerCase();

    // Check original query
    if (searchQuery.trim() && lowerText.includes(searchQuery.toLowerCase())) {
        return true;
    }

    // Check additional terms (e.g., stemmed terms from API)
    const terms = searchTerms || [];
    return terms.some(term => term.trim() && lowerText.includes(term.toLowerCase()));
}
