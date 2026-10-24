// ==UserScript==
// @name         Royal Road Foldable Chapter UI
// @namespace    https://github.com/royal-road-foldable-ui
// @version      1.0.6
// @description  Displays Royal Road chapters as two-column, page-flippable spreads on foldable phones in landscape mode.
// @match        https://www.royalroad.com/fiction/*/chapter/*
// @match        https://royalroad.com/fiction/*/chapter/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const ACTIVE_BODY_CLASS = "rrf-foldable-active";
    const ACTIVE_CONTENT_CLASS = "rrf-foldable-content";
    const CONTROLS_ID = "rrf-foldable-controls";
    const STYLE_ID = "rrf-foldable-styles";
    const TITLE_CLASS = "rrf-foldable-title";
    const AUTHOR_NOTE_CLASS = "rrf-foldable-author-note";
    const NEXT_CHAPTER_CLASS = "rrf-foldable-next-chapter";
    const HIDDEN_HEADER_CLASS = "rrf-foldable-hidden-header";
    const TOUCH_TARGETS_ID = "rrf-foldable-touch-targets";
    const HIDDEN_FEEDBACK_CLASS = "rrf-foldable-hidden-feedback";
    const MOBILE_LANDSCAPE_QUERY =
        "(orientation: landscape) and (min-width: 600px) and (max-width: 1000px)";

    let contentElement = null;
    let controlsElement = null;
    let titleElement = null;
    let authorNoteElements = [];
    let authorNoteSources = new Map();
    let nextChapterElement = null;
    let nextChapterSource = null;
    let nextChapterObserver = null;
    let siteHeaderElement = null;
    let touchTargetsElement = null;
    let feedbackElement = null;
    let readerColors = null;
    let originalReaderColorProperties = null;
    let pageIndex = 0;
    let pageCount = 1;
    let resizeTimer = null;
    let refreshTimer = null;
    let navigationFrame = null;
    const TOUCH_DRAG_THRESHOLD = 8;
    const TOUCH_SWIPE_DISTANCE = 40;
    const TOUCH_REVERSE_DISTANCE = 24;

    let touchStartX = null;
    let touchStartY = null;
    let touchStartScrollLeft = 0;
    let touchPeakDeltaX = 0;
    let touchLastX = null;
    let touchLastMoveTime = 0;
    let touchVelocityX = 0;
    let touchGestureAxis = null;
    let suppressClickUntil = 0;
    let readerSuspended = false;
    // Content position of the current page, captured on every user-initiated
    // page change while the layout is known to be valid. Used to keep the
    // reader on the same content across reflows and when leaving the reader.
    let lastReaderPosition = null;
    let cancelPendingDocumentScroll = null;
    // Content at the top of the normal page, sampled when scrolling stops.
    // A viewport change keeps scrollY but reflows the text, so by the time the
    // reader activates the content under the header has already moved; this
    // remembers what the user was actually looking at. `width` tags the
    // sample so ones taken mid-resize can be rejected.
    let documentPositionSample = null;
    let documentScrollTimer = null;
    let suppressScrollSamplingUntil = 0;

    function isSupportedViewport() {
        return window.matchMedia(MOBILE_LANDSCAPE_QUERY).matches;
    }

    function findChapterContent() {
        const preferred = document.querySelector(".chapter-content");
        if (preferred instanceof HTMLElement && preferred.textContent.trim()) {
            return preferred;
        }

        const fallback = document.querySelector(".chapter-inner");
        return fallback instanceof HTMLElement && fallback.textContent.trim()
            ? fallback
            : null;
    }

    function getChapterTitle() {
        const heading = document.querySelector(
            ".chapter-title, .chapter-header h1, h1"
        );
        if (heading instanceof HTMLElement && heading.textContent.trim()) {
            return heading.textContent.trim();
        }

        return document.title.split("|")[0].trim();
    }

    function findChapterLink(direction) {
        const labelPattern =
            direction === "next"
                ? /\bnext(?:\s+chapter)?\b/i
                : /\b(previous|prev)(?:\s+chapter)?\b/i;

        const currentUrl = new URL(window.location.href);
        const chapterLinks = [];
        for (const element of document.querySelectorAll(
            "[href*='/chapter/'], [data-href*='/chapter/'], [data-url*='/chapter/']"
        )) {
            if (
                (controlsElement && controlsElement.contains(element)) ||
                (contentElement && contentElement.contains(element))
            ) {
                continue;
            }
            const target =
                element.getAttribute("href") ||
                element.getAttribute("data-href") ||
                element.getAttribute("data-url");
            if (!target) {
                continue;
            }

            const resolved = new URL(target, window.location.origin);
            if (resolved.pathname === currentUrl.pathname) {
                continue;
            }
            const href = resolved.href;
            const label = [
                element.textContent,
                element.getAttribute("aria-label"),
                element.getAttribute("title")
            ]
                .filter(Boolean)
                .join(" ");

            if (labelPattern.test(label)) {
                return href;
            }
            if (
                element
                    .getAttribute("rel")
                    ?.split(/\s+/)
                    .includes(direction === "next" ? "next" : "prev")
            ) {
                return href;
            }
            chapterLinks.push(href);
        }

        const currentChapterId = Number(
            window.location.pathname.match(/\/chapter\/(\d+)/)?.[1]
        );
        if (!currentChapterId) {
            return null;
        }

        const candidates = [...new Set(chapterLinks)]
            .map((href) => ({
                href,
                id: Number(new URL(href).pathname.match(/\/chapter\/(\d+)/)?.[1])
            }))
            .filter(({ id }) => Number.isFinite(id) && id !== currentChapterId)
            .sort((first, second) => first.id - second.id);

        if (direction === "next") {
            return candidates.find(({ id }) => id > currentChapterId)?.href || null;
        }

        return [...candidates]
            .reverse()
            .find(({ id }) => id < currentChapterId)?.href || null;
    }

    function addChapterTitle() {
        if (!contentElement || titleElement) {
            return;
        }

        const title = getChapterTitle();
        if (!title) {
            return;
        }

        const header = document.createElement("header");
        header.className = TITLE_CLASS;
        const heading = document.createElement("h1");
        heading.textContent = title;
        header.appendChild(heading);
        contentElement.prepend(header);
        titleElement = header;
    }

    function isAuthorNote(element) {
        return /\b(?:author'?s?\s+note|note\s+from)\b/i.test(
            element.textContent
        );
    }

    function findAuthorNotes(content) {
        const containers = [
            content.parentElement,
            content.parentElement?.parentElement
        ].filter(Boolean);

        for (const container of containers) {
            const notes = [...container.children].filter(
                (element) =>
                    element !== content &&
                    !element.contains(content) &&
                    isAuthorNote(element)
            );
            if (notes.length) {
                return notes;
            }
        }

        return [];
    }

    function containsOtherRoyalRoadFictionLink(note) {
        const currentFictionId = window.location.pathname.match(
            /^\/fiction\/(\d+)/
        )?.[1];

        return [...note.querySelectorAll("a[href]")].some((link) => {
            if (!link.textContent.trim()) {
                return false;
            }

            const destination = new URL(link.href);
            const fictionId = destination.pathname.match(/^\/fiction\/(\d+)/)?.[1];

            return (
                /^(?:www\.)?royalroad\.com$/i.test(destination.hostname) &&
                fictionId &&
                fictionId !== currentFictionId
            );
        });
    }

    function createAuthorNote(note) {
        const details = document.createElement("details");
        details.className = AUTHOR_NOTE_CLASS;
        details.open = !containsOtherRoyalRoadFictionLink(note);

        const summary = document.createElement("summary");
        summary.textContent = "Author note";
        details.appendChild(summary);

        const noteContent = note.cloneNode(true);
        noteContent.removeAttribute("id");
        for (const elementWithId of noteContent.querySelectorAll("[id]")) {
            elementWithId.removeAttribute("id");
        }
        details.appendChild(noteContent);

        return details;
    }

    function addAuthorNotes() {
        if (!contentElement || authorNoteElements.length) {
            return;
        }

        const notes = findAuthorNotes(contentElement);
        const before = [];
        const after = [];

        for (const note of notes) {
            const readerNote = createAuthorNote(note);
            authorNoteSources.set(readerNote, note);
            // Expanding/collapsing a note reflows the columns.
            readerNote.addEventListener("toggle", () => recalculatePages(false));
            if (note.compareDocumentPosition(contentElement) & Node.DOCUMENT_POSITION_FOLLOWING) {
                before.push(readerNote);
            } else {
                after.push(readerNote);
            }
        }

        for (const note of before.reverse()) {
            contentElement.prepend(note);
        }
        for (const note of after) {
            if (
                nextChapterElement &&
                nextChapterElement.parentElement === contentElement
            ) {
                contentElement.insertBefore(note, nextChapterElement);
            } else {
                contentElement.appendChild(note);
            }
        }

        authorNoteElements = [...before, ...after];
        watchContentImages();
    }

    function findNextChapterWidget(content) {
        // Look directly for Royal Road's schedule banner (redesign or legacy alert).
        // Must be the banner itself, not a containing card or navigation portlet.
        const selectors = [
            "[class*='bg-info']",
            ".alert-info",
            "[class*='alert-info']",
            "[class*='next-chapter']"
        ];
        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (!(el instanceof HTMLElement)) {
                    continue;
                }
                if (
                    el === document.body ||
                    el === content ||
                    el.id === CONTROLS_ID ||
                    el.id === TOUCH_TARGETS_ID ||
                    el.classList.contains(NEXT_CHAPTER_CLASS) ||
                    el.classList.contains(AUTHOR_NOTE_CLASS) ||
                    (content && content.contains(el))
                ) {
                    continue;
                }

                const text = el.textContent || "";
                if (
                    /next\s+chapter\s*:/i.test(text) &&
                    el.querySelector("time") &&
                    !el.querySelector(
                        "a[href*='/chapter/'], select, button, .btn, #comments, [data-comment-id]"
                    )
                ) {
                    return el;
                }
            }
        }

        // Fallback: search upward from any <time> element that mentions "Next Chapter:".
        // Stop before outer container cards, navigation rows, or comment sections.
        for (const timeEl of document.querySelectorAll("time")) {
            if (content && content.contains(timeEl)) {
                continue;
            }
            let current = timeEl.parentElement;
            let candidate = null;
            while (current && current !== document.body && current !== content) {
                const text = current.textContent || "";
                if (/next\s+chapter\s*:/i.test(text)) {
                    if (
                        current.querySelector(
                            "a[href*='/chapter/'], select, button, .btn, #comments, [data-comment-id]"
                        )
                    ) {
                        break;
                    }
                    candidate = current;
                    if (
                        current.querySelector(
                            ".fa-clock, [class*='fa-clock'], [class*='clock']"
                        ) &&
                        current.querySelector("time")
                    ) {
                        return current;
                    }
                }
                current = current.parentElement;
            }
            if (candidate) {
                return candidate;
            }
        }

        return null;
    }

    function createNextChapterWidget(sourceWidget) {
        const widget = sourceWidget.cloneNode(true);
        for (const elementWithId of [widget, ...widget.querySelectorAll("[id]")]) {
            elementWithId.removeAttribute("id");
        }
        widget.classList.add(NEXT_CHAPTER_CLASS);
        return widget;
    }

    function addNextChapterWidget() {
        if (!contentElement || nextChapterElement) {
            return;
        }

        const sourceWidget = findNextChapterWidget(contentElement);
        if (!sourceWidget) {
            return;
        }

        nextChapterSource = sourceWidget;
        nextChapterElement = createNextChapterWidget(sourceWidget);
        contentElement.appendChild(nextChapterElement);

        nextChapterObserver = new MutationObserver(() => {
            if (!nextChapterElement || !sourceWidget) {
                return;
            }
            const sourceTimes = sourceWidget.querySelectorAll("time");
            const targetTimes = nextChapterElement.querySelectorAll("time");
            if (sourceTimes.length === targetTimes.length && sourceTimes.length > 0) {
                for (let i = 0; i < sourceTimes.length; i++) {
                    if (targetTimes[i].textContent !== sourceTimes[i].textContent) {
                        targetTimes[i].textContent = sourceTimes[i].textContent;
                    }
                }
            } else if (sourceWidget.textContent !== nextChapterElement.textContent) {
                nextChapterElement.innerHTML = sourceWidget.innerHTML;
                for (const el of nextChapterElement.querySelectorAll("[id]")) {
                    el.removeAttribute("id");
                }
            }
        });
        nextChapterObserver.observe(sourceWidget, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function findSiteHeader() {
        const homeLink = [...document.querySelectorAll("a[href]")].find(
            (link) =>
                /^(?:https?:\/\/(?:www\.)?royalroad\.com)?\/?$/.test(
                    link.href
                ) &&
                (link.querySelector("img") || /royal\s+road/i.test(link.textContent))
        );
        const logo = homeLink
            ? homeLink
            : [...document.images].find((image) =>
                /royal\s*road/i.test(`${image.alt} ${image.src}`)
            );

        if (!logo) {
            return null;
        }

        for (
            let element = logo.parentElement;
            element && element !== document.body;
            element = element.parentElement
        ) {
            const bounds = element.getBoundingClientRect();
            if (
                bounds.top <= 10 &&
                bounds.height >= 40 &&
                bounds.height <= 200 &&
                bounds.width >= window.innerWidth * 0.75
            ) {
                return element;
            }
        }

        return null;
    }

    function hideSiteHeader() {
        siteHeaderElement = findSiteHeader();
        siteHeaderElement?.classList.add(HIDDEN_HEADER_CLASS);
    }

    function findFeedbackElement() {
        const candidates = document.querySelectorAll(
            "button, a, [role='button'], [class*='feedback'], [id*='feedback']"
        );

        for (const candidate of candidates) {
            const label = [
                candidate.textContent,
                candidate.getAttribute("aria-label"),
                candidate.getAttribute("title")
            ]
                .filter(Boolean)
                .join(" ");
            const bounds = candidate.getBoundingClientRect();

            if (
                /\bbeta\b|\bfeedback\b/i.test(label) &&
                bounds.width <= 160 &&
                bounds.height <= 160 &&
                bounds.right >= window.innerWidth - 160 &&
                bounds.bottom >= window.innerHeight - 160
            ) {
                return candidate;
            }
        }

        return null;
    }

    function hideFeedback() {
        feedbackElement = findFeedbackElement();
        feedbackElement?.classList.add(HIDDEN_FEEDBACK_CLASS);
    }

    function isTransparentColor(color) {
        return (
            color === "transparent" ||
            /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(color)
        );
    }

    function applyReaderColors(content) {
        const foreground = window.getComputedStyle(content).color;
        let background = null;

        for (
            let element = content;
            element;
            element = element.parentElement
        ) {
            const candidate = window.getComputedStyle(element).backgroundColor;
            if (!isTransparentColor(candidate)) {
                background = candidate;
                break;
            }
        }

        readerColors = {
            background:
                background ||
                (window.matchMedia("(prefers-color-scheme: dark)").matches
                    ? "rgb(18, 18, 18)"
                    : "rgb(255, 255, 255)"),
            foreground
        };
        originalReaderColorProperties = {
            background: content.style.getPropertyValue("--rrf-page-background"),
            backgroundPriority: content.style.getPropertyPriority(
                "--rrf-page-background"
            ),
            foreground: content.style.getPropertyValue("--rrf-page-foreground"),
            foregroundPriority: content.style.getPropertyPriority(
                "--rrf-page-foreground"
            )
        };
        content.style.setProperty(
            "--rrf-page-background",
            readerColors.background
        );
        content.style.setProperty(
            "--rrf-page-foreground",
            readerColors.foreground
        );
    }

    function removeReaderColors() {
        if (!contentElement || !originalReaderColorProperties) {
            return;
        }

        const properties = [
            ["--rrf-page-background", "background", "backgroundPriority"],
            ["--rrf-page-foreground", "foreground", "foregroundPriority"]
        ];
        for (const [property, valueKey, priorityKey] of properties) {
            const value = originalReaderColorProperties[valueKey];
            if (value) {
                contentElement.style.setProperty(
                    property,
                    value,
                    originalReaderColorProperties[priorityKey]
                );
            } else {
                contentElement.style.removeProperty(property);
            }
        }

        readerColors = null;
        originalReaderColorProperties = null;
    }

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            body.${ACTIVE_BODY_CLASS} {
                overflow: hidden !important;
            }

            body.${ACTIVE_BODY_CLASS} #header,
            body.${ACTIVE_BODY_CLASS} .navbar:not(#${CONTROLS_ID}),
            body.${ACTIVE_BODY_CLASS} .navbar-fixed-top {
                display: none !important;
            }

            .${HIDDEN_HEADER_CLASS} {
                display: none !important;
            }

            .${HIDDEN_FEEDBACK_CLASS} {
                display: none !important;
            }

            .${ACTIVE_CONTENT_CLASS} {
                background: var(--rrf-page-background) !important;
                box-sizing: border-box !important;
                color: var(--rrf-page-foreground) !important;
                height: 100dvh !important;
                inset: 0 !important;
                margin: 0 !important;
                max-height: 100dvh !important;
                max-width: none !important;
                overflow-x: hidden !important;
                overflow-y: hidden !important;
                padding: 3.75rem 1rem 4.5rem !important;
                position: fixed !important;
                column-count: 2 !important;
                column-fill: auto !important;
                column-gap: 2rem !important;
                column-rule: 1px solid rgba(128, 128, 128, 0.35) !important;
                scroll-behavior: auto !important;
                scroll-snap-type: none !important;
                scrollbar-width: none !important;
                touch-action: none !important;
                width: 100vw !important;
                z-index: 2147483645 !important;
            }

            .${ACTIVE_CONTENT_CLASS}::after {
                background: rgba(128, 128, 128, 0.35);
                bottom: 4.5rem;
                content: "";
                left: 50%;
                pointer-events: none;
                position: absolute;
                top: 3.75rem;
                width: 1px;
            }

            .${ACTIVE_CONTENT_CLASS}::-webkit-scrollbar {
                display: none;
            }

            .${ACTIVE_CONTENT_CLASS} > * {
                break-inside: avoid;
            }

            /* Let prose paragraphs split across columns/pages so a short
               paragraph doesn't get pushed to its own page ahead of a long one. */
            .${ACTIVE_CONTENT_CLASS} > p {
                break-inside: auto;
            }

            .${TITLE_CLASS} {
                background: var(--rrf-page-background);
                left: 1rem;
                overflow: hidden;
                position: absolute;
                right: 1rem;
                text-overflow: ellipsis;
                top: 1rem;
                white-space: nowrap;
                z-index: 1;
            }

            .${TITLE_CLASS} h1 {
                font: inherit;
                font-size: 1.1rem;
                font-weight: 700;
                margin: 0;
            }

            .${AUTHOR_NOTE_CLASS} {
                background: color-mix(
                    in srgb,
                    var(--rrf-page-foreground) 8%,
                    var(--rrf-page-background)
                );
                border: 1px solid
                    color-mix(in srgb, var(--rrf-page-foreground) 20%, transparent);
                border-radius: 0.4rem;
                -webkit-box-decoration-break: clone;
                box-decoration-break: clone;
                break-inside: auto !important;
                box-sizing: border-box;
                margin: 0 0 1rem;
                max-width: 100%;
                overflow: visible !important;
                overflow-wrap: anywhere;
                padding: 0.5rem 0.75rem;
                width: 100%;
            }

            .${AUTHOR_NOTE_CLASS} summary {
                cursor: pointer;
                font-weight: 700;
            }

            .${AUTHOR_NOTE_CLASS} > :not(summary) {
                box-sizing: border-box;
                margin: 0.75rem 0 0 !important;
                max-width: 100%;
                padding: 0 !important;
                width: auto !important;
            }

            .${AUTHOR_NOTE_CLASS} * {
                break-inside: auto !important;
                box-sizing: border-box;
                float: none !important;
                max-width: 100%;
                min-height: 0 !important;
                overflow: visible !important;
            }

            .${AUTHOR_NOTE_CLASS} div,
            .${AUTHOR_NOTE_CLASS} p,
            .${AUTHOR_NOTE_CLASS} blockquote,
            .${AUTHOR_NOTE_CLASS} figure,
            .${AUTHOR_NOTE_CLASS} figcaption,
            .${AUTHOR_NOTE_CLASS} table,
            .${AUTHOR_NOTE_CLASS} thead,
            .${AUTHOR_NOTE_CLASS} tbody,
            .${AUTHOR_NOTE_CLASS} tfoot,
            .${AUTHOR_NOTE_CLASS} tr,
            .${AUTHOR_NOTE_CLASS} td,
            .${AUTHOR_NOTE_CLASS} th {
                display: block !important;
                height: auto !important;
                max-height: none !important;
                width: auto !important;
            }

            .${AUTHOR_NOTE_CLASS} .tools {
                display: none !important;
            }

            .${AUTHOR_NOTE_CLASS} :last-child {
                margin-bottom: 0 !important;
            }

            .${ACTIVE_CONTENT_CLASS} img,
            .${ACTIVE_CONTENT_CLASS} svg,
            .${ACTIVE_CONTENT_CLASS} video,
            .${ACTIVE_CONTENT_CLASS} canvas {
                break-inside: avoid !important;
                height: auto !important;
                max-height: calc(100dvh - 10rem) !important;
                max-width: 100% !important;
                object-fit: contain !important;
                vertical-align: bottom;
                width: auto !important;
            }

            .${AUTHOR_NOTE_CLASS} img,
            .${AUTHOR_NOTE_CLASS} svg,
            .${AUTHOR_NOTE_CLASS} video,
            .${AUTHOR_NOTE_CLASS} canvas {
                max-height: calc(100dvh - 15rem) !important;
            }

            .${NEXT_CHAPTER_CLASS} {
                background: color-mix(
                    in srgb,
                    var(--rrf-page-foreground) 8%,
                    var(--rrf-page-background)
                );
                border: 1px solid
                    color-mix(in srgb, var(--rrf-page-foreground) 20%, transparent);
                border-radius: 0.4rem;
                break-inside: avoid !important;
                box-sizing: border-box !important;
                margin: 1.5rem 0 1rem !important;
                max-width: 100% !important;
                overflow: hidden !important;
            }

            .${NEXT_CHAPTER_CLASS} * {
                box-sizing: border-box !important;
                max-width: 100% !important;
            }

            .${NEXT_CHAPTER_CLASS} [class*='text-info'],
            .${NEXT_CHAPTER_CLASS} i.fa-clock,
            .${NEXT_CHAPTER_CLASS} [class*='clock'] {
                flex-shrink: 0;
            }

            .${NEXT_CHAPTER_CLASS} .flex-grow {
                flex-grow: 1;
                min-width: 0;
            }

            #${TOUCH_TARGETS_ID} {
                bottom: 4rem;
                display: flex;
                left: 0;
                pointer-events: none;
                position: fixed;
                right: 0;
                top: 3.75rem;
                z-index: 2147483646;
            }

            #${TOUCH_TARGETS_ID} button {
                background: transparent;
                border: 0;
                flex: 0 0 14%;
                margin: 0;
                opacity: 0;
                padding: 0;
                pointer-events: auto;
                touch-action: none;
            }

            #${TOUCH_TARGETS_ID} .rrf-foldable-touch-spacer {
                flex: 1 1 auto;
                pointer-events: none;
            }

            #${CONTROLS_ID} {
                align-items: center;
                background: transparent;
                border: 0;
                bottom: 0;
                color: var(--rrf-page-foreground);
                display: flex;
                gap: 0.75rem;
                justify-content: center;
                left: 0;
                padding: 0.65rem 1rem;
                position: fixed;
                right: 0;
                z-index: 2147483647;
            }

            #${CONTROLS_ID} button {
                align-items: center;
                background: transparent;
                border: 1px solid transparent;
                border-radius: 0.4rem;
                color: inherit;
                display: inline-flex;
                font: inherit;
                justify-content: center;
                min-height: 2.75rem;
                min-width: 3.25rem;
                padding: 0.35rem 0.75rem;
                touch-action: manipulation;
            }

            #${CONTROLS_ID} a {
                align-items: center;
                border: 1px solid transparent;
                border-radius: 0.4rem;
                color: inherit;
                display: inline-flex;
                font: inherit;
                justify-content: center;
                min-height: 2.75rem;
                padding: 0.35rem 0.5rem;
                text-decoration: none;
                touch-action: manipulation;
            }

            #${CONTROLS_ID} button:active,
            #${CONTROLS_ID} button:focus-visible,
            #${CONTROLS_ID} a:active,
            #${CONTROLS_ID} a:focus-visible {
                background: color-mix(in srgb, currentColor 12%, transparent);
                border-color: color-mix(in srgb, currentColor 30%, transparent);
            }

            #rrf-foldable-page {
                color: inherit;
                min-width: 5rem;
                text-align: center;
            }
        `;
        document.head.appendChild(style);
    }

    function updateControls() {
        if (!controlsElement) {
            return;
        }

        const pageLabel = controlsElement.querySelector("#rrf-foldable-page");
        const previousButton = controlsElement.querySelector("[data-direction='previous']");
        const nextButton = controlsElement.querySelector("[data-direction='next']");

        if (pageLabel) {
            pageLabel.textContent = `Page ${pageIndex + 1} of ${pageCount}`;
        }
        if (previousButton instanceof HTMLButtonElement) {
            previousButton.disabled = pageIndex === 0;
        }
        if (nextButton instanceof HTMLButtonElement) {
            nextButton.disabled = pageIndex >= pageCount - 1;
        }
    }

    function createTouchTargets() {
        const targets = document.createElement("div");
        targets.id = TOUCH_TARGETS_ID;
        targets.setAttribute("aria-label", "Page turn touch targets");
        targets.innerHTML = `
            <button type="button" data-direction="previous" aria-label="Previous page"></button>
            <span class="rrf-foldable-touch-spacer" aria-hidden="true"></span>
            <button type="button" data-direction="next" aria-label="Next page"></button>
        `;
        targets.addEventListener("click", (event) => {
            const button =
                event.target instanceof Element
                    ? event.target.closest("button[data-direction]")
                    : null;
            if (!button) {
                return;
            }
            goToPage(pageIndex + (button.dataset.direction === "next" ? 1 : -1));
        });
        document.body.appendChild(targets);
        touchTargetsElement = targets;
    }

    function goToPage(nextIndex, behavior = "smooth") {
        if (!contentElement) {
            return;
        }

        pageIndex = Math.max(0, Math.min(nextIndex, pageCount - 1));
        // The capture uses pageIndex (not scrollLeft), so it is valid even
        // before the smooth scroll reaches the target page.
        lastReaderPosition = captureReaderPosition();
        contentElement.scrollTo({
            left: pageIndex * contentElement.clientWidth,
            behavior
        });
        updateControls();
    }

    function findPageForPosition(position) {
        if (!contentElement || !position) {
            return null;
        }

        const node = contentElement.contains(position.node)
            ? position.node
            : mapOriginalNodeToReader(position.node);
        if (!node || !node.isConnected || !contentElement.contains(node)) {
            return null;
        }

        let rect = null;
        if (node.nodeType === Node.TEXT_NODE) {
            const length = node.data.length;
            const range = document.createRange();
            range.setStart(node, Math.min(position.offset, length));
            range.setEnd(node, Math.min(position.offset + 1, length));
            rect = range.getBoundingClientRect();
        } else {
            rect = node.getBoundingClientRect();
        }
        if (!rect.width && !rect.height) {
            return null;
        }

        const contentX =
            rect.left -
            contentElement.getBoundingClientRect().left +
            contentElement.scrollLeft;
        return Math.floor(contentX / contentElement.clientWidth);
    }

    function recalculatePages(resetToStart) {
        if (!contentElement || contentElement.clientWidth === 0) {
            return;
        }

        pageCount = Math.max(
            1,
            Math.ceil(contentElement.scrollWidth / contentElement.clientWidth)
        );
        // Open on the page holding the tracked content: after a reflow (resize,
        // image load, note toggle, ads) that is the page being read; on
        // activation it is whatever was at the top of the normal page.
        const restoredPage = findPageForPosition(lastReaderPosition);
        if (restoredPage !== null) {
            pageIndex = restoredPage;
        } else if (resetToStart) {
            pageIndex = 0;
        }
        pageIndex = Math.max(0, Math.min(pageIndex, pageCount - 1));

        const targetLeft = pageIndex * contentElement.clientWidth;
        // Only snap if we are off a page boundary; unconditionally assigning
        // scrollLeft here would cancel in-flight smooth page turns whenever
        // unrelated DOM mutations (ads, comments) trigger a refresh.
        if (
            touchGestureAxis !== "horizontal" &&
            Math.abs(contentElement.scrollLeft - targetLeft) > 1
        ) {
            contentElement.scrollLeft = targetLeft;
        }
        if (resetToStart || lastReaderPosition === null) {
            lastReaderPosition = captureReaderPosition();
        }
        updateControls();
    }

    function handleContentLoad() {
        recalculatePages(false);
    }

    function watchContentImages() {
        if (!contentElement) {
            return;
        }

        for (const image of contentElement.querySelectorAll("img")) {
            if (!image.complete) {
                image.addEventListener("load", handleContentLoad, {
                    once: true
                });
            }
        }
    }

    function createControls() {
        const controls = document.createElement("nav");
        controls.id = CONTROLS_ID;
        controls.setAttribute("aria-label", "Chapter pages");
        if (readerColors) {
            controls.style.setProperty(
                "--rrf-page-background",
                readerColors.background
            );
            controls.style.setProperty(
                "--rrf-page-foreground",
                readerColors.foreground
            );
        }
        controls.innerHTML = `
            <button type="button" data-direction="previous" aria-label="Previous page">‹</button>
            <span id="rrf-foldable-page" aria-live="polite"></span>
            <button type="button" data-direction="next" aria-label="Next page">›</button>
        `;
        const previousChapter = findChapterLink("previous");
        const nextChapter = findChapterLink("next");

        if (previousChapter) {
            const previousLink = document.createElement("a");
            previousLink.href = previousChapter;
            previousLink.textContent = "Previous chapter";
            previousLink.setAttribute("aria-label", "Previous chapter");
            controls.prepend(previousLink);
        }
        if (nextChapter) {
            const nextLink = document.createElement("a");
            nextLink.href = nextChapter;
            nextLink.textContent = "Next chapter";
            nextLink.setAttribute("aria-label", "Next chapter");
            controls.appendChild(nextLink);
        }
        controls.addEventListener("click", (event) => {
            const button =
                event.target instanceof Element
                    ? event.target.closest("button[data-direction]")
                    : null;
            if (!button) {
                return;
            }
            goToPage(pageIndex + (button.dataset.direction === "next" ? 1 : -1));
        });
        document.body.appendChild(controls);
        controlsElement = controls;
    }

    function handleKeydown(event) {
        if (!contentElement || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        if (event.key === "ArrowRight" || event.key === "PageDown") {
            event.preventDefault();
            goToPage(pageIndex + 1);
        } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
            event.preventDefault();
            goToPage(pageIndex - 1);
        } else if (event.key === "Home") {
            event.preventDefault();
            goToPage(0);
        } else if (event.key === "End") {
            event.preventDefault();
            goToPage(pageCount - 1);
        }
    }

    function handleScroll() {
        if (
            !contentElement ||
            touchGestureAxis === "horizontal" ||
            navigationFrame !== null
        ) {
            return;
        }

        navigationFrame = window.requestAnimationFrame(() => {
            navigationFrame = null;
            if (
                !contentElement ||
                touchGestureAxis === "horizontal" ||
                contentElement.clientWidth === 0
            ) {
                return;
            }

            const width = contentElement.clientWidth;
            const nearestPage = Math.round(contentElement.scrollLeft / width);
            // Ignore intermediate positions of a smooth scroll; otherwise a
            // second tap mid-animation would re-target the page we just left.
            if (Math.abs(contentElement.scrollLeft - nearestPage * width) > 1) {
                return;
            }
            pageIndex = Math.max(0, Math.min(pageCount - 1, nearestPage));
            updateControls();
        });
    }

    function resetTouchState() {
        touchStartX = null;
        touchStartY = null;
        touchStartScrollLeft = 0;
        touchPeakDeltaX = 0;
        touchLastX = null;
        touchLastMoveTime = 0;
        touchVelocityX = 0;
        touchGestureAxis = null;
    }

    function snapToNearestPage() {
        if (!contentElement || contentElement.clientWidth <= 0) {
            return;
        }
        const nearestPage = Math.round(
            contentElement.scrollLeft / contentElement.clientWidth
        );
        goToPage(nearestPage, "smooth");
    }

    function handleTouchStart(event) {
        if (!contentElement || event.touches.length !== 1) {
            if (touchGestureAxis === "horizontal") {
                snapToNearestPage();
            }
            resetTouchState();
            return;
        }

        const touch = event.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        touchStartScrollLeft = contentElement.scrollLeft;
        touchPeakDeltaX = 0;
        touchLastX = touch.clientX;
        touchLastMoveTime = performance.now();
        touchVelocityX = 0;
        touchGestureAxis = null;
    }

    function handleTouchMove(event) {
        if (
            !contentElement ||
            touchStartX === null ||
            touchStartY === null ||
            event.touches.length !== 1
        ) {
            return;
        }

        const touch = event.touches[0];
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;

        if (touchGestureAxis === null) {
            if (
                Math.abs(deltaX) < TOUCH_DRAG_THRESHOLD &&
                Math.abs(deltaY) < TOUCH_DRAG_THRESHOLD
            ) {
                return;
            }
            touchGestureAxis =
                Math.abs(deltaX) >= Math.abs(deltaY)
                    ? "horizontal"
                    : "vertical";
        }

        if (touchGestureAxis !== "horizontal") {
            return;
        }

        if (event.cancelable) {
            event.preventDefault();
        }

        const now = performance.now();
        const dt = now - touchLastMoveTime;
        if (dt > 0 && touchLastX !== null) {
            touchVelocityX = (touch.clientX - touchLastX) / dt;
        }
        touchLastX = touch.clientX;
        touchLastMoveTime = now;

        if (Math.abs(deltaX) > Math.abs(touchPeakDeltaX)) {
            touchPeakDeltaX = deltaX;
        }

        const maxScrollLeft = Math.max(
            0,
            (pageCount - 1) * contentElement.clientWidth
        );
        contentElement.scrollLeft = Math.max(
            0,
            Math.min(maxScrollLeft, touchStartScrollLeft - deltaX)
        );
    }

    function handleTouchEnd(event) {
        if (
            !contentElement ||
            touchStartX === null ||
            touchStartY === null ||
            event.changedTouches.length !== 1
        ) {
            if (touchGestureAxis === "horizontal") {
                snapToNearestPage();
            }
            resetTouchState();
            return;
        }

        const touch = event.changedTouches[0];
        const horizontalDistance = touch.clientX - touchStartX;
        const verticalDistance = touch.clientY - touchStartY;
        const axis = touchGestureAxis;
        const peakDeltaX = touchPeakDeltaX;
        const velocityX = touchVelocityX;
        const startPage =
            contentElement.clientWidth > 0
                ? Math.round(touchStartScrollLeft / contentElement.clientWidth)
                : pageIndex;

        resetTouchState();

        if (axis !== null) {
            suppressClickUntil = performance.now() + 100;
        }

        if (axis === "horizontal") {
            if (event.cancelable) {
                event.preventDefault();
            }
            const width = contentElement.clientWidth;
            if (width <= 0) {
                return;
            }

            let targetPage = Math.round(contentElement.scrollLeft / width);
            const swipedEnough =
                Math.abs(horizontalDistance) >= TOUCH_SWIPE_DISTANCE;
            const reversedDirection =
                (horizontalDistance < 0 &&
                    (velocityX > 0.05 ||
                        horizontalDistance - peakDeltaX >
                            TOUCH_REVERSE_DISTANCE)) ||
                (horizontalDistance > 0 &&
                    (velocityX < -0.05 ||
                        peakDeltaX - horizontalDistance >
                            TOUCH_REVERSE_DISTANCE));

            if (swipedEnough && !reversedDirection && horizontalDistance !== 0) {
                targetPage = startPage + (horizontalDistance < 0 ? 1 : -1);
            }

            // Clamp to at most one page from startPage so swipes never
            // momentum-scroll across multiple pages.
            targetPage = Math.max(
                startPage - 1,
                Math.min(startPage + 1, targetPage)
            );
            goToPage(targetPage, "smooth");
            return;
        }

        const isVerticalSwipe =
            (axis === "vertical" ||
                Math.abs(verticalDistance) > Math.abs(horizontalDistance)) &&
            Math.abs(verticalDistance) >= TOUCH_SWIPE_DISTANCE;

        if (isVerticalSwipe) {
            if (event.cancelable) {
                event.preventDefault();
            }
            leaveReader(verticalDistance < 0 ? "next" : "previous");
        }
    }

    function handleTouchCancel() {
        if (touchGestureAxis === "horizontal") {
            snapToNearestPage();
        }
        resetTouchState();
    }

    function findCommentSection() {
        // Royal Road: `<a id="comments">` is an empty anchor; the visible block is
        // `.portlet.comments-container`, whose `#comment-loader` is lazily filled by
        // the site's own IntersectionObserver once it scrolls into view.
        const knownContainer = document.querySelector(
            ".comments-container, #comments-container, #chapter-comments, .chapter-comments, [data-comment-section]"
        );
        if (knownContainer) {
            return knownContainer;
        }

        const loader = document.querySelector("#comment-loader, .comment-container");
        if (loader) {
            return loader.closest(".portlet, section") || loader;
        }

        const anchor = document.querySelector("#comments");
        if (anchor) {
            return anchor.nextElementSibling || anchor;
        }

        const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].find(
            (element) => /^comments(?:\s*\(\d+\))?$/i.test(element.textContent.trim())
        );
        return heading?.closest("section, .portlet, .panel, div") || heading || null;
    }

    const ATOMIC_ELEMENT_PATTERN = /^(?:img|video|iframe|hr|canvas|svg|picture)$/i;

    function getNodeFragmentRects(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const range = document.createRange();
            range.selectNodeContents(node);
            return range.getClientRects();
        }
        if (node instanceof Element) {
            return node.getClientRects();
        }
        return [];
    }

    function mapReaderNodeToOriginal(node, offset = 0) {
        for (const [readerNote, originalNote] of authorNoteSources) {
            if (!readerNote.contains(node)) {
                continue;
            }

            const cloneRoot = readerNote.lastElementChild;
            if (!cloneRoot || !cloneRoot.contains(node)) {
                return { node: originalNote, offset: 0 };
            }

            const path = [];
            for (let current = node; current !== cloneRoot; current = current.parentNode) {
                path.unshift(
                    Array.prototype.indexOf.call(current.parentNode.childNodes, current)
                );
            }

            let target = originalNote;
            for (const index of path) {
                target = target.childNodes[index];
                if (!target) {
                    return { node: originalNote, offset: 0 };
                }
            }
            return {
                node: target,
                offset: target.nodeType === Node.TEXT_NODE ? offset : 0
            };
        }

        if (
            nextChapterElement &&
            nextChapterSource &&
            nextChapterElement.contains(node)
        ) {
            return { node: nextChapterSource, offset: 0 };
        }

        return { node, offset };
    }

    function mapOriginalNodeToReader(node) {
        for (const [readerNote, originalNote] of authorNoteSources) {
            if (!originalNote.contains(node)) {
                continue;
            }

            if (!readerNote.open) {
                return readerNote.querySelector("summary") || readerNote;
            }

            const cloneRoot = readerNote.lastElementChild;
            if (!cloneRoot) {
                return readerNote;
            }

            const path = [];
            for (let current = node; current !== originalNote; current = current.parentNode) {
                path.unshift(
                    Array.prototype.indexOf.call(current.parentNode.childNodes, current)
                );
            }

            let target = cloneRoot;
            for (const index of path) {
                target = target.childNodes[index];
                if (!target) {
                    return readerNote;
                }
            }
            return target;
        }

        if (
            nextChapterElement &&
            nextChapterSource &&
            nextChapterSource.contains(node)
        ) {
            return nextChapterElement;
        }

        return node;
    }

    /**
     * Finds the first piece of content (text character or image) inside `root`
     * for which `rectMatches` holds. `elementIsBefore(bounds)` is a pre-filter
     * that lets whole subtrees be skipped. Content order must agree with the
     * geometric order implied by the predicates (true for normal flow).
     */
    function findFirstContentPosition(root, rectMatches, elementIsBefore) {
        const anyRectMatches = (rects) => {
            for (const rect of rects) {
                if (rect.width > 0 && rect.height > 0 && rectMatches(rect)) {
                    return true;
                }
            }
            return false;
        };

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (node === titleElement) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (node.nodeType === Node.TEXT_NODE) {
                        return node.data.trim()
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP;
                    }
                    if (ATOMIC_ELEMENT_PATTERN.test(node.nodeName)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    // The bounding box is the union of all fragments (columns
                    // included), so a block that ends before the target region
                    // cannot contain anything in it: skip its subtree.
                    const bounds = node.getBoundingClientRect();
                    if (
                        (bounds.width > 0 || bounds.height > 0) &&
                        elementIsBefore(bounds)
                    ) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            }
        );

        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!anyRectMatches(getNodeFragmentRects(node))) {
                continue;
            }

            let offset = 0;
            if (node.nodeType === Node.TEXT_NODE) {
                // This text node straddles the boundary: binary-search the first
                // character whose line is inside the target region.
                const range = document.createRange();
                range.setStart(node, 0);
                let low = 1;
                let high = node.data.length;
                while (low < high) {
                    const middle = (low + high) >>> 1;
                    range.setEnd(node, middle);
                    if (anyRectMatches(range.getClientRects())) {
                        high = middle;
                    } else {
                        low = middle + 1;
                    }
                }
                offset = Math.max(0, low - 1);
            }

            return mapReaderNodeToOriginal(node, offset);
        }

        return null;
    }

    /** First content on the current reader page (reader must be active). */
    function captureReaderPosition() {
        if (!contentElement || contentElement.clientWidth === 0) {
            return null;
        }

        const contentLeft = contentElement.getBoundingClientRect().left;
        const scrollLeft = contentElement.scrollLeft;
        const pageStart = pageIndex * contentElement.clientWidth - 1;
        const toContentX = (clientX) => clientX - contentLeft + scrollLeft;

        return findFirstContentPosition(
            contentElement,
            (rect) => toContentX(rect.left) >= pageStart,
            (bounds) => toContentX(bounds.right) < pageStart
        );
    }

    function getDocumentRoots(content) {
        const notes = findAuthorNotes(content);
        const before = [];
        const after = [];
        for (const note of notes) {
            if (
                note.compareDocumentPosition(content) &
                Node.DOCUMENT_POSITION_FOLLOWING
            ) {
                before.push(note);
            } else {
                after.push(note);
            }
        }
        const nextWidget = findNextChapterWidget(content);
        return [
            ...before,
            content,
            ...after,
            ...(nextWidget ? [nextWidget] : [])
        ];
    }

    /**
     * First content visible below the header in the normal (non-reader)
     * layout, so the reader can open on the page the user was looking at.
     */
    function captureDocumentPosition(content) {
        // A line must show more than the 12px gap scrollDocumentTo() leaves
        // above the target line, so that leaving and re-entering the reader
        // round-trips to the same line.
        const topEdge = getFixedHeaderHeight() + 13;
        for (const root of getDocumentRoots(content)) {
            const bounds = root.getBoundingClientRect();
            if (
                (bounds.width > 0 || bounds.height > 0) &&
                bounds.bottom <= topEdge
            ) {
                continue;
            }
            const position = findFirstContentPosition(
                root,
                (rect) => rect.bottom > topEdge,
                (b) => b.bottom <= topEdge
            );
            if (position) {
                return position;
            }
        }
        return null;
    }

    function sampleDocumentPosition() {
        if (contentElement) {
            return;
        }
        if (
            documentPositionSample &&
            documentPositionSample.width !== window.innerWidth
        ) {
            // Viewport is changing; refresh()/activate() will reset sampling.
            return;
        }

        const content = findChapterContent();
        if (content) {
            documentPositionSample = {
                position: captureDocumentPosition(content),
                width: window.innerWidth
            };
        }
    }

    function takeDocumentPosition(content) {
        const sampled = documentPositionSample?.position;
        documentPositionSample = null;
        if (
            sampled &&
            sampled.node.isConnected &&
            getDocumentRoots(content).some((root) => root.contains(sampled.node))
        ) {
            return sampled;
        }
        if (window.scrollY <= 1) {
            return null;
        }
        return captureDocumentPosition(content);
    }

    function getDocumentTop(node, offset) {
        if (!node || !node.isConnected) {
            return null;
        }

        let rect = null;
        if (node.nodeType === Node.TEXT_NODE) {
            const length = node.data.length;
            const range = document.createRange();
            range.setStart(node, Math.min(offset, length));
            range.setEnd(node, Math.min(offset + 1, length));
            rect = range.getBoundingClientRect();
            if (!rect.height) {
                rect = node.parentElement?.getBoundingClientRect() || null;
            }
        } else if (node instanceof Element) {
            rect = node.getBoundingClientRect();
        }

        if (!rect || (!rect.height && !rect.width)) {
            return null;
        }
        return rect.top + window.scrollY;
    }

    function getFixedHeaderHeight() {
        let height = 0;
        for (const element of document.querySelectorAll(
            ".page-header-top, .page-header-menu, .page-header, .navbar-fixed-top, header"
        )) {
            const position = window.getComputedStyle(element).position;
            if (position !== "fixed" && position !== "sticky") {
                continue;
            }
            const bounds = element.getBoundingClientRect();
            if (bounds.top <= 1 && bounds.height > 0 && bounds.height <= 200) {
                height = Math.max(height, bounds.bottom);
            }
        }
        return height;
    }

    /**
     * Scrolls the document so the position returned by `resolveTop` sits just
     * below any fixed header. The scroll is re-applied a few times to absorb
     * layout shifts (ads, lazily loaded comments, the header becoming fixed),
     * but gives up as soon as the user scrolls on their own.
     */
    function scrollDocumentTo(resolveTop) {
        let appliedTop = null;
        let finished = false;
        const appliedTargets = new Set();
        const timers = [];
        const apply = () => {
            if (
                finished ||
                (appliedTop !== null && Math.abs(window.scrollY - appliedTop) > 2)
            ) {
                finished = true;
                return;
            }

            const top = resolveTop();
            if (top === null) {
                return;
            }

            const target = Math.max(
                0,
                Math.round(top - getFixedHeaderHeight() - 12)
            );
            if (appliedTargets.has(target)) {
                // A layout that reacts to scrolling (e.g. a header that becomes
                // fixed) is bouncing the target around; settle where we are.
                finished = true;
                return;
            }
            appliedTargets.add(target);

            window.scrollTo({ top: target, left: 0, behavior: "instant" });
            appliedTop = window.scrollY;
            // Our own scroll events must not replace the exact position sample.
            suppressScrollSamplingUntil = performance.now() + 300;
        };

        cancelPendingDocumentScroll?.();
        window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
        for (const delay of [250, 750, 1500]) {
            timers.push(window.setTimeout(apply, delay));
        }
        cancelPendingDocumentScroll = () => {
            finished = true;
            for (const timer of timers) {
                window.clearTimeout(timer);
            }
            cancelPendingDocumentScroll = null;
        };
    }

    function leaveReader(direction) {
        if (!contentElement) {
            return;
        }

        const goToComments = direction === "next" && pageIndex >= pageCount - 1;
        const position = goToComments ? null : captureReaderPosition();

        readerSuspended = true;
        deactivate();

        if (goToComments) {
            scrollDocumentTo(() => {
                const section = findCommentSection();
                return section
                    ? getDocumentTop(section, 0)
                    : document.documentElement.scrollHeight;
            });
        } else {
            scrollToReaderPosition(position);
        }
    }

    function scrollToReaderPosition(position) {
        if (!position) {
            return;
        }
        scrollDocumentTo(() => getDocumentTop(position.node, position.offset));
        // Remember the exact position rather than re-deriving it from the
        // scrolled geometry later, so re-entering the reader (unfolding)
        // returns to the same page even when it sits on a page boundary.
        documentPositionSample = { position, width: window.innerWidth };
    }

    function activate(content) {
        if (contentElement === content) {
            let changed = false;
            if (
                !authorNoteElements.length &&
                findAuthorNotes(contentElement).length > 0
            ) {
                addAuthorNotes();
                changed = true;
            }
            if (!nextChapterElement && findNextChapterWidget(contentElement)) {
                addNextChapterWidget();
                changed = true;
            }
            if (changed) {
                recalculatePages(false);
            }
            return;
        }

        deactivate();
        // Work out which content is at the top of the screen, then reset the
        // document scroll before taking the chapter out of the flow. Leaving
        // the document scrolled deep (e.g. after reading in portrait) while
        // the page collapses to header + footer is what let the footer show
        // through on Firefox for Android; a fresh load never has this problem.
        const documentPosition = takeDocumentPosition(content);
        cancelPendingDocumentScroll?.();
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        addStyles();
        contentElement = content;
        applyReaderColors(contentElement);
        contentElement.classList.add(ACTIVE_CONTENT_CLASS);
        document.body.classList.add(ACTIVE_BODY_CLASS);
        hideSiteHeader();
        hideFeedback();
        addChapterTitle();
        addAuthorNotes();
        addNextChapterWidget();
        createTouchTargets();
        createControls();
        watchContentImages();
        contentElement.addEventListener("load", handleContentLoad, true);
        contentElement.addEventListener("scroll", handleScroll, { passive: true });
        // Swipes are also recognised on the edge touch targets, otherwise a
        // vertical swipe starting near either edge would be swallowed.
        for (const element of [contentElement, touchTargetsElement]) {
            element.addEventListener("touchstart", handleTouchStart, {
                passive: true
            });
            element.addEventListener("touchmove", handleTouchMove, {
                passive: false
            });
            element.addEventListener("touchend", handleTouchEnd, {
                passive: false
            });
            element.addEventListener("touchcancel", handleTouchCancel, {
                passive: true
            });
        }
        document.addEventListener("keydown", handleKeydown);
        pageIndex = 0;
        lastReaderPosition = documentPosition;
        window.requestAnimationFrame(() => recalculatePages(true));
    }

    function deactivate() {
        if (contentElement) {
            contentElement.classList.remove(ACTIVE_CONTENT_CLASS);
            contentElement.removeEventListener("load", handleContentLoad, true);
            contentElement.removeEventListener("scroll", handleScroll);
            contentElement.removeEventListener("touchstart", handleTouchStart);
            contentElement.removeEventListener("touchmove", handleTouchMove);
            contentElement.removeEventListener("touchend", handleTouchEnd);
            contentElement.removeEventListener("touchcancel", handleTouchCancel);
        }
        if (controlsElement) {
            controlsElement.remove();
        }
        if (touchTargetsElement) {
            touchTargetsElement.remove();
        }
        if (titleElement) {
            titleElement.remove();
        }
        siteHeaderElement?.classList.remove(HIDDEN_HEADER_CLASS);
        feedbackElement?.classList.remove(HIDDEN_FEEDBACK_CLASS);
        for (const authorNoteElement of authorNoteElements) {
            authorNoteElement.remove();
        }
        authorNoteSources = new Map();
        if (nextChapterElement) {
            nextChapterElement.remove();
        }
        if (nextChapterObserver) {
            nextChapterObserver.disconnect();
            nextChapterObserver = null;
        }
        nextChapterElement = null;
        nextChapterSource = null;
        document.body.classList.remove(ACTIVE_BODY_CLASS);
        document.removeEventListener("keydown", handleKeydown);
        removeReaderColors();
        contentElement = null;
        controlsElement = null;
        touchTargetsElement = null;
        feedbackElement = null;
        titleElement = null;
        authorNoteElements = [];
        siteHeaderElement = null;
        resetTouchState();
        pageIndex = 0;
        pageCount = 1;
    }

    function refresh() {
        if (isCommentLink()) {
            readerSuspended = false;
            deactivate();
            return;
        }

        if (!isSupportedViewport()) {
            // Folding the phone / rotating to portrait leaves the reader too:
            // land on the content that was being read, not the page top.
            readerSuspended = false;
            if (contentElement) {
                const position = lastReaderPosition;
                deactivate();
                documentPositionSample = null;
                scrollToReaderPosition(position);
            }
            return;
        }

        if (readerSuspended) {
            return;
        }

        const chapterContent = findChapterContent();
        if (chapterContent) {
            activate(chapterContent);
        } else {
            deactivate();
        }
    }

    function scheduleRefresh() {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(refresh, 100);
    }

    function isCommentLink() {
        // Royal Road links to comments with either ?comment=<id> or #comment-<id>.
        return (
            new URL(window.location.href).searchParams.has("comment") ||
            /^#comment-/.test(window.location.hash)
        );
    }

    const FULLSCREEN_KEY = "rrf-foldable-fullscreen";
    const FULLSCREEN_TAP_INTERVAL = 500;
    const ROYAL_ROAD_DOUBLE_TAP_WINDOW = 650;
    const FULLSCREEN_TAP_DISTANCE = 48;
    const CHAPTER_STYLE_ATTR = "data-rrf-chapter-style";
    const READER_PREFERENCE_CLASS_PATTERN =
        /^(?:font-size-|width-|font-family-|reset-fonts$|indent-|strip-colors$|paragraph-spacing-)/;

    let pageUnloading = false;
    let lastChapterClickTime = 0;
    let lastFullscreenTapTime = 0;
    let lastFullscreenTapX = 0;
    let lastFullscreenTapY = 0;
    let activeChapterNavigation = null;
    let currentChapterPath = window.location.pathname;

    function setFullscreenPreference(enabled) {
        try {
            if (enabled) {
                sessionStorage.setItem(FULLSCREEN_KEY, "1");
            } else {
                sessionStorage.removeItem(FULLSCREEN_KEY);
            }
        } catch (error) {
            // Storage may be unavailable; fullscreen then simply isn't restored.
        }
    }

    function wantsFullscreen() {
        try {
            return sessionStorage.getItem(FULLSCREEN_KEY) === "1";
        } catch (error) {
            return false;
        }
    }

    function getFullscreenElement() {
        return (
            document.fullscreenElement ||
            document.webkitFullscreenElement ||
            null
        );
    }

    function requestFullscreen() {
        const root = document.documentElement;
        if (getFullscreenElement()) {
            return Promise.resolve();
        }
        if (typeof root.requestFullscreen === "function") {
            return root
                .requestFullscreen({ navigationUI: "hide" })
                .catch(() => root.requestFullscreen())
                .then(
                    () => {
                        setFullscreenPreference(true);
                    },
                    () => {
                        if (!getFullscreenElement()) {
                            setFullscreenPreference(false);
                        }
                    }
                );
        }
        if (typeof root.webkitRequestFullscreen === "function") {
            try {
                root.webkitRequestFullscreen();
            } catch (error) {
                setFullscreenPreference(false);
            }
        }
        return Promise.resolve();
    }

    function exitFullscreen() {
        if (!getFullscreenElement()) {
            return Promise.resolve();
        }
        if (typeof document.exitFullscreen === "function") {
            return document.exitFullscreen().catch(() => {});
        }
        if (typeof document.webkitExitFullscreen === "function") {
            try {
                document.webkitExitFullscreen();
            } catch (error) {}
        }
        return Promise.resolve();
    }

    function toggleFullscreen() {
        if (getFullscreenElement()) {
            setFullscreenPreference(false);
            exitFullscreen();
        } else {
            setFullscreenPreference(true);
            requestFullscreen();
        }
    }

    function isInteractiveReaderTarget(target) {
        return (
            target instanceof Element &&
            Boolean(
                target.closest(
                    "a, button, summary, input, select, textarea, label, [role='button']"
                )
            )
        );
    }

    function isSameFictionChapterUrl(href) {
        try {
            const target = new URL(href, window.location.origin);
            if (target.origin !== window.location.origin) {
                return false;
            }
            if (
                target.searchParams.has("comment") ||
                /^#comment-/.test(target.hash)
            ) {
                return false;
            }
            if (
                target.pathname === window.location.pathname &&
                target.hash
            ) {
                return false;
            }
            const currentFictionId = window.location.pathname.match(
                /^\/fiction\/(\d+)\//
            )?.[1];
            const targetMatch = target.pathname.match(
                /^\/fiction\/(\d+)\/[^/]+\/chapter\/\d+/
            );
            if (!targetMatch) {
                return false;
            }
            return !currentFictionId || targetMatch[1] === currentFictionId;
        } catch (error) {
            return false;
        }
    }

    function syncFetchedHead(nextDoc) {
        if (nextDoc.title) {
            document.title = nextDoc.title;
        }

        for (const link of document.head.querySelectorAll(
            "link[rel='next'], link[rel='prev'], link[rel='canonical']"
        )) {
            link.remove();
        }
        for (const link of nextDoc.head.querySelectorAll(
            "link[rel='next'], link[rel='prev'], link[rel='canonical']"
        )) {
            document.head.appendChild(document.importNode(link, true));
        }

        for (const style of document.head.querySelectorAll(
            `style[${CHAPTER_STYLE_ATTR}]`
        )) {
            style.remove();
        }
        for (const style of nextDoc.head.querySelectorAll("style")) {
            if (style.id === STYLE_ID) {
                continue;
            }
            const clone = document.importNode(style, true);
            clone.setAttribute(CHAPTER_STYLE_ATTR, "true");
            document.head.appendChild(clone);
        }
    }

    function setupFetchedChapterEnhancements() {
        const chapterIdMatch = window.location.pathname.match(/\/chapter\/(\d+)/);
        if (chapterIdMatch) {
            const parsedId = Number(chapterIdMatch[1]);
            if (Number.isFinite(parsedId)) {
                window.chapterId = parsedId;
            }
        }

        for (const paragraph of document.querySelectorAll(".chapter-content p")) {
            if (
                paragraph.style.marginBottom &&
                ["0.001pt", "1em"].includes(paragraph.style.marginBottom)
            ) {
                paragraph.style.marginBottom = "";
            }
        }

        try {
            window.royalroad?.convertTime?.();
            window.royalroad?.spoilers?.loadSpoilers?.();
        } catch (error) {}

        const commentLoader = document.getElementById("comment-loader");
        if (
            commentLoader &&
            typeof window.loadComments === "function" &&
            window.chapterId
        ) {
            const targetChapterId = window.chapterId;
            new IntersectionObserver(
                (entries, observer) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            window.loadComments(1, targetChapterId, null, true);
                            observer.unobserve(entry.target);
                        }
                    }
                },
                { rootMargin: "0px 0px 50px 0px", threshold: 0 }
            ).observe(commentLoader);
        }
    }

    function applyFetchedChapterDocument(nextDoc, finalUrl, pushState) {
        const currentChapterEl = document.querySelector(".chapter");
        const preservedChapterClasses = currentChapterEl
            ? [...currentChapterEl.classList].filter((className) =>
                  READER_PREFERENCE_CLASS_PATTERN.test(className)
              )
            : [];

        cancelPendingDocumentScroll?.();
        window.clearTimeout(refreshTimer);
        window.clearTimeout(documentScrollTimer);
        if (navigationFrame !== null) {
            window.cancelAnimationFrame(navigationFrame);
            navigationFrame = null;
        }

        deactivate();
        syncFetchedHead(nextDoc);

        if (pushState && finalUrl !== window.location.href) {
            history.pushState(null, "", finalUrl);
        }
        currentChapterPath = window.location.pathname;

        const currentContainer =
            document.querySelector(".container.chapter-page") ||
            document.querySelector("main");
        const nextContainer =
            nextDoc.querySelector(".container.chapter-page") ||
            nextDoc.querySelector("main");

        if (
            currentContainer &&
            nextContainer &&
            currentContainer.tagName === nextContainer.tagName
        ) {
            currentContainer.replaceWith(document.adoptNode(nextContainer));
        } else {
            for (const script of nextDoc.body.querySelectorAll("script")) {
                script.remove();
            }
            document.body.replaceChildren(
                ...[...nextDoc.body.childNodes].map((node) =>
                    document.adoptNode(node)
                )
            );
        }

        const updatedChapterEl = document.querySelector(".chapter");
        if (updatedChapterEl && preservedChapterClasses.length > 0) {
            updatedChapterEl.classList.add(...preservedChapterClasses);
        }

        setupFetchedChapterEnhancements();

        readerSuspended = false;
        lastReaderPosition = null;
        documentPositionSample = null;
        resetTouchState();
        pageIndex = 0;
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        refresh();
    }

    async function navigateToChapter(targetUrl, { pushState = true } = {}) {
        if (activeChapterNavigation) {
            activeChapterNavigation.abort();
        }
        const controller = new AbortController();
        activeChapterNavigation = controller;

        if (controlsElement) {
            for (const link of controlsElement.querySelectorAll("a")) {
                link.style.pointerEvents = "none";
                link.style.opacity = "0.5";
            }
        }

        try {
            const response = await fetch(targetUrl, {
                credentials: "same-origin",
                signal: controller.signal
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();
            if (controller.signal.aborted) {
                return;
            }

            const nextDoc = new DOMParser().parseFromString(html, "text/html");
            const nextContent =
                nextDoc.querySelector(".chapter-content") ||
                nextDoc.querySelector(".chapter-inner");
            if (
                !(nextContent instanceof HTMLElement) ||
                !nextContent.textContent.trim()
            ) {
                throw new Error("No chapter content in response");
            }

            const finalUrl = response.url || targetUrl;
            applyFetchedChapterDocument(nextDoc, finalUrl, pushState);
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            pageUnloading = true;
            window.location.href = targetUrl;
        } finally {
            if (activeChapterNavigation === controller) {
                activeChapterNavigation = null;
            }
        }
    }

    function handleDocumentClickCapture(event) {
        if (performance.now() < suppressClickUntil) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }

        if (
            !event.defaultPrevented &&
            event.button === 0 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey
        ) {
            const link =
                event.target instanceof Element
                    ? event.target.closest("a[href]")
                    : null;
            if (
                link instanceof HTMLAnchorElement &&
                link.target !== "_blank" &&
                (contentElement !== null ||
                    getFullscreenElement() !== null ||
                    wantsFullscreen()) &&
                ((controlsElement && controlsElement.contains(link)) ||
                    (!link.hasAttribute("data-subscriber-nav") &&
                        isSameFictionChapterUrl(link.href)))
            ) {
                event.preventDefault();
                event.stopPropagation();
                if (wantsFullscreen() && !getFullscreenElement()) {
                    requestFullscreen();
                }
                navigateToChapter(link.href, { pushState: true });
                return;
            }
        }

        const chapterRoot =
            contentElement &&
            event.target instanceof Node &&
            contentElement.contains(event.target)
                ? contentElement
                : event.target instanceof Element
                  ? event.target.closest(".chapter-content, .chapter-inner")
                  : null;

        if (wantsFullscreen() && !getFullscreenElement()) {
            lastFullscreenTapTime = 0;
            requestFullscreen();
            if (chapterRoot) {
                lastChapterClickTime = Date.now();
                if (
                    isInteractiveReaderTarget(event.target) &&
                    event.target instanceof Element
                ) {
                    event.target.addEventListener(
                        "click",
                        (bubbleEvent) => bubbleEvent.stopPropagation(),
                        { once: true }
                    );
                } else {
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                }
            }
            return;
        }

        if (!chapterRoot) {
            return;
        }

        const now = Date.now();
        const sinceLastChapterClick = now - lastChapterClickTime;
        lastChapterClickTime = now;

        if (isInteractiveReaderTarget(event.target)) {
            lastFullscreenTapTime = 0;
            if (
                sinceLastChapterClick > 0 &&
                sinceLastChapterClick < ROYAL_ROAD_DOUBLE_TAP_WINDOW &&
                event.target instanceof Element
            ) {
                event.target.addEventListener(
                    "click",
                    (bubbleEvent) => bubbleEvent.stopPropagation(),
                    { once: true }
                );
            }
            return;
        }

        // Swallow rapid second clicks in the capture phase so Royal Road's own
        // bubbling .chapter-content click listener never triggers its toastr
        // popup or fights with our fullscreen state.
        if (
            sinceLastChapterClick > 0 &&
            sinceLastChapterClick < ROYAL_ROAD_DOUBLE_TAP_WINDOW
        ) {
            event.stopPropagation();
            event.stopImmediatePropagation();
        }

        const sinceLastTap = now - lastFullscreenTapTime;
        const withinDistance =
            Math.hypot(
                event.clientX - lastFullscreenTapX,
                event.clientY - lastFullscreenTapY
            ) <= FULLSCREEN_TAP_DISTANCE;

        if (
            sinceLastTap > 0 &&
            sinceLastTap < FULLSCREEN_TAP_INTERVAL &&
            withinDistance
        ) {
            lastFullscreenTapTime = 0;
            window.getSelection()?.removeAllRanges();
            toggleFullscreen();
            return;
        }

        lastFullscreenTapTime = now;
        lastFullscreenTapX = event.clientX;
        lastFullscreenTapY = event.clientY;
    }

    window.addEventListener("beforeunload", () => {
        pageUnloading = true;
    });
    window.addEventListener("pagehide", () => {
        pageUnloading = true;
    });
    window.addEventListener("pageshow", () => {
        pageUnloading = false;
    });
    document.addEventListener("fullscreenchange", () => {
        if (getFullscreenElement()) {
            // Double-clicking selects a word; drop it when entering fullscreen.
            window.getSelection()?.removeAllRanges();
            setFullscreenPreference(true);
        } else if (!pageUnloading && document.visibilityState === "visible") {
            setFullscreenPreference(false);
        }
        if (contentElement && isSupportedViewport()) {
            window.requestAnimationFrame(() => recalculatePages(false));
        }
    });
    document.addEventListener("click", handleDocumentClickCapture, true);
    document.addEventListener(
        "dblclick",
        (event) => {
            if (
                contentElement &&
                event.target instanceof Node &&
                contentElement.contains(event.target) &&
                !isInteractiveReaderTarget(event.target)
            ) {
                window.getSelection()?.removeAllRanges();
            }
        },
        true
    );

    window.addEventListener("resize", () => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            if (contentElement && isSupportedViewport()) {
                recalculatePages(false);
            } else {
                refresh();
            }
        }, 150);
    });
    window.addEventListener(
        "scroll",
        () => {
            if (contentElement) {
                return;
            }
            window.clearTimeout(documentScrollTimer);
            if (performance.now() < suppressScrollSamplingUntil) {
                return;
            }
            documentScrollTimer = window.setTimeout(sampleDocumentPosition, 150);
        },
        { passive: true }
    );
    window.addEventListener("orientationchange", scheduleRefresh);
    window.addEventListener("popstate", () => {
        if (
            window.location.pathname !== currentChapterPath &&
            /^\/fiction\/.*\/chapter\/\d+/.test(window.location.pathname)
        ) {
            navigateToChapter(window.location.href, { pushState: false });
            return;
        }
        scheduleRefresh();
    });
    document.addEventListener("DOMContentLoaded", refresh, { once: true });
    new MutationObserver((mutations) => {
        if (
            mutations.some(
                (mutation) =>
                    !controlsElement ||
                    !controlsElement.contains(mutation.target)
            )
        ) {
            scheduleRefresh();
        }
    }).observe(document.documentElement, {
        childList: true,
        subtree: true
    });
    refresh();
})();