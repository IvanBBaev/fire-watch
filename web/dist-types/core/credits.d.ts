/**
 * Attribution registry — the licence fee, in code.
 *
 * Every string here is reproduced exactly as its provider publishes it, in the
 * provider's own language and punctuation. The source of truth is the table
 * "Attribution strings — verbatim" in docs/DATA-SOURCES.md; this file is built from
 * that table and must be changed only together with it. Do not paraphrase, translate,
 * reflow or tidy a string: several of them are the literal condition on which we are
 * allowed to redistribute the data at all (ADR-001 A1.4).
 *
 * WP5's CI-13 asserts that the rendered attribution block contains the asserted text of
 * every credit that is currently rendering. Entries that are not verified against the
 * provider yet, and the Esri entry (whose wording is injected live by the ArcGIS plugin
 * and must never be hand-copied), are deliberately outside that assertion set.
 */
/** Where a credit has to appear. A credit may need several surfaces at once. */
export type CreditSurface = 'map-corner' | 'credits-page' | 'about' | 'alert-footer';
/**
 * What has to be true for a credit to be owed. Attribution follows the data actually
 * used, so a layer that is switched off owes nothing — and a layer that is switched on
 * owes immediately, which is why this is a machine-readable condition and not a comment.
 */
export type CreditCondition = 'always' | 'basemap:openfreemap' | 'basemap:protomaps' | 'layer:gibs' | 'layer:effis' | 'layer:gwis' | 'layer:terrain' | 'layer:landsat' | 'imagery:sentinel-unmodified' | 'toggle:esri' | 'never';
export interface Credit {
    /** Stable key. Referenced by CI-13 failure messages; never reused for a new string. */
    readonly id: string;
    /** Which source or layer this credit pays for. */
    readonly source: string;
    /**
     * The string as rendered, verbatim from the provider, possibly containing the
     * placeholders below.
     */
    readonly text: string;
    /**
     * Set only when the rendered sentence embeds a verbatim clause inside wording of
     * ours. CI-13 then asserts this substring instead of the whole sentence, so our
     * connective words stay editable while the provider's words do not.
     */
    readonly verbatim?: string;
    /** Link the string must carry, where the licence requires a reachable one. */
    readonly href?: string;
    readonly surfaces: readonly CreditSurface[];
    readonly condition: CreditCondition;
    /** False for credits the provider requests but does not require (Protomaps). */
    readonly required: boolean;
    /**
     * True when a third-party plugin renders the attribution itself. We assert that its
     * element is present; we never keep our own copy of the wording, because the provider
     * changes it (Maxar → Vantor) without warning us.
     */
    readonly pluginInjected?: boolean;
    /**
     * False while the exact wording has not been checked against the provider. Unverified
     * entries render but are excluded from the CI-13 assertion set, so an approximate
     * string can never harden into a "verified" one just by sitting in CI.
     */
    readonly verified: boolean;
    /** Where the wording comes from, for the next person who is asked to change it. */
    readonly authority: string;
}
/** Substituted with the year of publication or distribution of the data actually used. */
export declare const YEAR_PLACEHOLDER = "[YEAR]";
/** Substituted with the product name, so the derivation sentence names the deriver. */
export declare const PRODUCT_PLACEHOLDER = "[Product]";
export declare const CREDITS: readonly Credit[];
/**
 * The assembled map-corner line. Kept as one string rather than joined from CREDITS at
 * render time: the corner has a fixed reading order and merges the two Copernicus rows
 * into a single clause, which no generic join would reproduce.
 */
export declare const MAP_CORNER_LINE: string;
export interface RenderContext {
    /** Year of publication or distribution of the data actually used. */
    readonly year: number;
    /** Product name substituted into the derivation sentence. */
    readonly productName: string;
}
/** The credit as it appears on screen, with placeholders resolved. */
export declare function renderCredit(credit: Credit, context: RenderContext): string;
/**
 * The substring CI-13 must find in the rendered block: the provider's own words, which
 * is the whole string unless we wrapped a verbatim clause in wording of ours.
 */
export declare function assertedText(credit: Credit, context: RenderContext): string;
/** The credits owed right now, given which layers and basemap are active. */
export declare function creditsFor(surface: CreditSurface, activeConditions: readonly CreditCondition[]): readonly Credit[];
/**
 * The subset CI-13 asserts: owed, not optional, wording verified, and not rendered for
 * us by a third-party plugin.
 */
export declare function assertableCredits(surface: CreditSurface, activeConditions: readonly CreditCondition[]): readonly Credit[];
//# sourceMappingURL=credits.d.ts.map