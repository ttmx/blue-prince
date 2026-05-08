<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createId,
		db,
		deleteEvidence,
		getAllEvidence,
		getSetting,
		saveEvidencePatch,
		setSetting
	} from '$lib/services/db';
	import { fileToEvidenceImage } from '$lib/services/media';
	import {
		embedEvidenceText,
		modelStatus,
		processEvidence,
		setOcrProvider,
		setTextEmbeddingProvider
	} from '$lib/services/ai.svelte';
	import { defaultFilters, searchEvidence, type SearchFilters } from '$lib/services/search';
	import { exportProject, importProject } from '$lib/services/project';
	import type {
		EvidenceItem,
		OcrProvider,
		SearchResult,
		SearchTelemetry,
		TextEmbeddingProvider
	} from '$lib/types/evidence';

	let evidence = $state<EvidenceItem[]>([]);
	let results = $state<SearchResult[]>([]);
	let selectedId = $state('');
	let query = $state('');
	let filters = $state<SearchFilters>(defaultFilters());
	let activeMobileTab = $state<'board' | 'capture' | 'search' | 'scratchpad' | 'settings' | 'detail'>('board');
	let noteDraft = $state('');
	let scratchpad = $state('');
	let scratchpadLoaded = $state(false);
	let ocrProvider = $state<OcrProvider>('tesseract');
	let textEmbeddingProvider = $state<TextEmbeddingProvider>('browser');
	let mistralApiKey = $state('');
	let mistralKeyLoaded = $state(false);
	let aiSettingsLoaded = $state(false);
	let aiBackendStatus = $state('');
	let aiBackendChecking = $state(false);
	let isDragging = $state(false);
	let searchBusy = $state(false);
	let searchTelemetry = $state<SearchTelemetry | undefined>();
	let searchElapsedMs = $state(0);
	let toast = $state('');
	let selectedImageUrl = $state('');
	let importInput: HTMLInputElement;
	let imageInput: HTMLInputElement;

	const selected = $derived(evidence.find((item) => item.id === selectedId) ?? evidence[0]);
	const visibleResults = $derived(query.trim() ? results : evidence.map((item) => ({ item, score: 0, reasons: [] })));
	const evidenceNumbers = $derived(
		new Map(
			[...evidence]
				.sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id))
				.map((item, index) => [item.id, index + 1])
		)
	);
	const scratchpadParts = $derived(parseScratchpad(scratchpad));
	const tags = $derived([...new Set(evidence.flatMap((item) => item.tags))].sort());
	const rooms = $derived([...new Set(evidence.map((item) => item.room).filter(Boolean))].sort());
	const puzzles = $derived([...new Set(evidence.map((item) => item.puzzle).filter(Boolean))].sort());
	const processingCount = $derived(
		evidence.filter((item) => item.processingState === 'queued' || item.processingState === 'processing').length
	);

	onMount(() => {
		void refresh();
		void getSetting('scratchpad', '').then((value) => {
			scratchpad = value;
			scratchpadLoaded = true;
		});
		void getSetting<OcrProvider>('ocrProvider', 'tesseract').then((value) => {
			ocrProvider = value === 'mistral' || value === 'server' ? value : 'tesseract';
			setOcrProvider(ocrProvider);
		});
		void getSetting<TextEmbeddingProvider>('textEmbeddingProvider', 'browser').then((value) => {
			textEmbeddingProvider = value === 'server' ? 'server' : 'browser';
			setTextEmbeddingProvider(textEmbeddingProvider);
			aiSettingsLoaded = true;
		});
		void getSetting('mistralApiKey', '').then((value) => {
			mistralApiKey = value;
			mistralKeyLoaded = true;
		});

		const pasteHandler = (event: ClipboardEvent) => {
			const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
			if (files.length) {
				event.preventDefault();
				void addImageFiles(files);
			}
		};

		window.addEventListener('paste', pasteHandler);

		return () => {
			window.removeEventListener('paste', pasteHandler);
		};
	});

	$effect(() => {
		const currentQuery = query;
		const currentFilters = { ...filters };
		const currentEvidence = evidence;
		let interval: ReturnType<typeof setInterval> | undefined;

		searchBusy = Boolean(currentQuery.trim());
		searchElapsedMs = 0;

		if (searchBusy) {
			const startedAt = performance.now();
			interval = setInterval(() => {
				searchElapsedMs = performance.now() - startedAt;
			}, 100);
		} else {
			searchTelemetry = undefined;
		}

		void searchEvidence(currentEvidence, currentQuery, currentFilters, (telemetry) => {
			if (currentQuery === query) {
				searchTelemetry = telemetry;
				searchElapsedMs = (telemetry.finishedAt ?? performance.now()) - telemetry.startedAt;
			}
		})
			.then((nextResults) => {
				if (currentQuery === query) results = nextResults;
			})
			.finally(() => {
				if (currentQuery === query) {
					searchBusy = false;
					if (interval) clearInterval(interval);
				}
			});

		return () => {
			if (interval) clearInterval(interval);
		};
	});

	$effect(() => {
		const blob = selected?.imageBlob;
		const url = blob ? URL.createObjectURL(blob) : '';
		selectedImageUrl = url;

		return () => {
			if (url) URL.revokeObjectURL(url);
		};
	});

	$effect(() => {
		if (!scratchpadLoaded) return;
		const value = scratchpad;
		const timeout = setTimeout(() => {
			void setSetting('scratchpad', value);
		}, 350);

		return () => clearTimeout(timeout);
	});

	$effect(() => {
		setOcrProvider(ocrProvider);
		void setSetting('ocrProvider', ocrProvider);
	});

	$effect(() => {
		if (!aiSettingsLoaded) return;
		setTextEmbeddingProvider(textEmbeddingProvider);
		void setSetting('textEmbeddingProvider', textEmbeddingProvider);
	});

	$effect(() => {
		if (!mistralKeyLoaded) return;
		const value = mistralApiKey.trim();
		const timeout = setTimeout(() => {
			void setSetting('mistralApiKey', value);
		}, 350);

		return () => clearTimeout(timeout);
	});

	async function refresh() {
		evidence = await getAllEvidence();
		if (!selectedId && evidence[0]) selectedId = evidence[0].id;
	}

	async function addImageFiles(files: File[]) {
		const queuedItems: EvidenceItem[] = [];

		for (const file of files) {
			const now = Date.now();
			const image = await fileToEvidenceImage(file);
			const item: EvidenceItem = {
				id: createId(),
				kind: 'screenshot',
				title: 'Screenshot clue',
				createdAt: now,
				updatedAt: now,
				...image,
				ocrText: '',
				manualNotes: '',
				tags: [],
				room: '',
				puzzle: '',
				processingState: 'queued',
				processingMessage: 'Waiting for OCR'
			};

			await db.evidence.add(item);
			queuedItems.push(item);
			selectedId = item.id;
		}

		await refresh();
		showToast(`${files.length} screenshot${files.length === 1 ? '' : 's'} added`);

		for (const item of queuedItems) {
			setTimeout(() => {
				void processEvidence(item).finally(refresh);
			}, 50);
		}
	}

	async function addNote() {
		const text = noteDraft.trim();
		if (!text) return;

		const now = Date.now();
		const item: EvidenceItem = {
			id: createId(),
			kind: 'note',
			title: text.split('\n')[0].slice(0, 72) || 'Field note',
			createdAt: now,
			updatedAt: now,
			ocrText: '',
			manualNotes: text,
			tags: [],
			room: '',
			puzzle: '',
			processingState: 'complete',
			processingMessage: 'Indexed'
		};

		await db.evidence.add(item);
		selectedId = item.id;
		noteDraft = '';
		void embedEvidenceText(item).finally(refresh);
		await refresh();
	}

	async function updateSelected(patch: Partial<EvidenceItem>) {
		if (!selected) return;
		await saveEvidencePatch(selected.id, patch);
		await refresh();
		const latest = await db.evidence.get(selected.id);
		if (latest) void embedEvidenceText(latest);
	}

	async function retrySelected() {
		if (!selected) return;
		await saveEvidencePatch(selected.id, {
			processingState: 'queued',
			processingMessage: 'Queued for re-indexing',
			error: undefined
		});
		void processEvidence({ ...selected, processingState: 'queued' }).finally(refresh);
		await refresh();
	}

	async function removeSelected() {
		if (!selected) return;
		await deleteEvidence(selected.id);
		selectedId = '';
		await refresh();
	}

	async function exportBoard() {
		const blob = await exportProject();
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `blue-prince-evidence-${new Date().toISOString().slice(0, 10)}.zip`;
		anchor.click();
		URL.revokeObjectURL(url);
		showToast('Project exported');
	}

	function openOriginalImage() {
		if (!selectedImageUrl) return;
		window.open(selectedImageUrl, '_blank', 'noopener,noreferrer');
	}

	async function handleImport(files: FileList | null) {
		const file = files?.[0];
		if (!file) return;

		await importProject(file);
		await refresh();
		showToast('Project imported');
	}

	function updateTags(value: string) {
		void updateSelected({
			tags: value
				.split(',')
				.map((tag) => tag.trim())
				.filter(Boolean)
		});
	}

	function drop(event: DragEvent) {
		event.preventDefault();
		isDragging = false;
		const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
		if (files.length) void addImageFiles(files);
	}

	function showToast(message: string) {
		toast = message;
		setTimeout(() => {
			if (toast === message) toast = '';
		}, 2600);
	}

	function evidenceNumber(item: EvidenceItem) {
		return evidenceNumbers.get(item.id) ?? 0;
	}

	function evidenceByNumber(number: number) {
		return evidence.find((item) => evidenceNumber(item) === number);
	}

	function openEvidenceNumber(number: number) {
		const item = evidenceByNumber(number);
		if (!item) return;
		selectedId = item.id;
		activeMobileTab = 'detail';
	}

	function cardDescription(item: EvidenceItem) {
		const text = item.ocrText || item.manualNotes || item.processingMessage || 'No text yet';
		return item.kind === 'note' && text === item.title ? '' : text;
	}

	function formatDuration(milliseconds: number | undefined) {
		if (milliseconds === undefined) return '';
		if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
		return `${(milliseconds / 1000).toFixed(1)}s`;
	}

	async function checkAiBackend() {
		aiBackendChecking = true;
		aiBackendStatus = 'Checking private backend...';

		try {
			const response = await fetch('/api/ai/health');
			const text = await response.text();

			if (!response.ok) {
				aiBackendStatus = `Backend check failed (${response.status}): ${text || response.statusText}`;
				return;
			}

			const health = JSON.parse(text) as {
				ocr_provider?: string;
				ocr_model?: string;
				embedding_provider?: string;
				embedding_model?: string;
			};
			aiBackendStatus = `Connected: OCR ${health.ocr_model ?? health.ocr_provider ?? 'ready'}, embeddings ${health.embedding_model ?? health.embedding_provider ?? 'ready'}`;
		} catch (error) {
			aiBackendStatus = error instanceof Error ? error.message : 'Backend check failed.';
		} finally {
			aiBackendChecking = false;
		}
	}

	function parseScratchpad(value: string) {
		return value.split(/(#\d+)/g).map((part) => {
			const match = /^#(\d+)$/.exec(part);
			return match ? { kind: 'ref' as const, text: part, number: Number(match[1]) } : { kind: 'text' as const, text: part };
		});
	}
</script>

<svelte:head>
	<title>Blue Prince Evidence Board</title>
	<meta
		name="description"
		content="A local-first evidence board for Blue Prince screenshots, OCR, notes, and search."
	/>
</svelte:head>

<main
	class="min-h-screen bg-[#111820] text-[#f3eee3]"
	ondragover={(event) => {
		event.preventDefault();
		isDragging = true;
	}}
	ondragleave={() => (isDragging = false)}
	ondrop={drop}
>
	<header class="sticky top-0 z-30 border-b border-[#34414a] bg-[#111820]/95 px-4 py-3 backdrop-blur md:px-5">
		<div class="flex flex-col gap-3 lg:flex-row lg:items-center">
			<div class="flex min-w-56 items-center justify-between gap-3">
				<div>
					<p class="text-xs font-semibold uppercase tracking-[0.18em] text-[#c5a464]">Blue Prince</p>
					<h1 class="text-xl font-semibold text-[#fff8e8]">Evidence Board</h1>
				</div>
				<div class="rounded border border-[#4d5c65] bg-[#1c2630] px-2 py-1 text-xs text-[#c7d2d0]">
					{evidence.length} items
				</div>
			</div>

			<div class="flex flex-1 flex-col gap-2 md:flex-row md:items-center">
				<label class="relative flex-1">
					<span class="sr-only">Search evidence</span>
					<input
						class="h-11 w-full rounded border border-[#4d5c65] bg-[#18222c] px-4 pr-24 text-sm text-[#fff8e8] outline-none ring-[#7db7aa] placeholder:text-[#89979b] focus:ring-2"
						placeholder="Search notes, OCR text, tags, rooms, and clues"
						bind:value={query}
					/>
					<span class="absolute right-3 top-3 text-xs text-[#9db4b1]">
						{searchBusy ? 'indexing' : query ? `${visibleResults.length} hits` : 'ready'}
					</span>
				</label>

				<div class="flex items-center gap-2 overflow-x-auto">
					<button class="text-button" onclick={() => (activeMobileTab = 'board')}>Board</button>
					<button class="text-button" onclick={() => (activeMobileTab = 'scratchpad')}>Scratchpad</button>
					<button class="text-button" onclick={() => (activeMobileTab = 'settings')}>Settings</button>
					<button class="icon-button" title="Choose screenshots" onclick={() => imageInput.click()}>
						<span>+</span>
					</button>
					<button class="text-button" onclick={exportBoard}>Export</button>
					<button class="text-button" onclick={() => importInput.click()}>Import</button>
				</div>
			</div>
		</div>

		<div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#b7c3bf]">
			<span class="status-pill">OCR: {modelStatus.ocr}</span>
			<span class="status-pill">Text: {modelStatus.text}</span>
			<span class="status-pill">Image: {modelStatus.image}</span>
			<span class="status-pill">AI: {modelStatus.backend}</span>
			{#if processingCount}
				<span class="status-pill border-[#8f7442] text-[#f1d397]">{processingCount} processing</span>
			{/if}
			{#if toast}
				<span class="ml-auto text-[#9bd3c6]">{toast}</span>
			{/if}
		</div>
	</header>

	<input
		bind:this={imageInput}
		class="hidden"
		type="file"
		accept="image/*"
		multiple
		onchange={(event) => addImageFiles([...(event.currentTarget.files ?? [])])}
	/>
	<input
		bind:this={importInput}
		class="hidden"
		type="file"
		accept=".zip,application/zip"
		onchange={(event) => handleImport(event.currentTarget.files)}
	/>

	<nav class="grid grid-cols-6 border-b border-[#2b3841] bg-[#17212a] text-sm md:hidden">
		{#each ['board', 'capture', 'search', 'scratchpad', 'settings', 'detail'] as tab}
			<button
				class="px-1 py-3 text-xs capitalize {activeMobileTab === tab ? 'bg-[#22313b] text-[#fff8e8]' : 'text-[#a9b7b5]'}"
				onclick={() => (activeMobileTab = tab as typeof activeMobileTab)}
			>
				{tab}
			</button>
		{/each}
	</nav>

	<section class="grid min-h-[calc(100vh-126px)] grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)_360px]">
		<aside class="workspace-panel {activeMobileTab === 'capture' ? 'block' : 'hidden'} md:block">
			<div
				class="drop-zone {isDragging ? 'border-[#9bd3c6] bg-[#1f3638]' : ''}"
				role="button"
				tabindex="0"
				onclick={() => imageInput.click()}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') imageInput.click();
				}}
			>
				<div class="text-3xl text-[#c5a464]">+</div>
				<h2 class="mt-2 text-base font-semibold text-[#fff8e8]">Paste screenshots</h2>
				<p class="mt-1 text-sm text-[#aebbb7]">Use clipboard paste anywhere, or drop and choose files here.</p>
			</div>

			<label class="mt-5 block text-sm font-medium text-[#e9ddc8]" for="quick-note">Quick note</label>
			<textarea
				id="quick-note"
				class="mt-2 min-h-36 w-full resize-y rounded border border-[#3f4d55] bg-[#18222c] p-3 text-sm text-[#fff8e8] outline-none ring-[#7db7aa] placeholder:text-[#7f8f91] focus:ring-2"
				placeholder="Type a clue, room observation, safe code, symbol pattern..."
				bind:value={noteDraft}
			></textarea>
			<button class="mt-3 w-full rounded bg-[#c5a464] px-3 py-2 text-sm font-semibold text-[#172027]" onclick={addNote}>
				Add note
			</button>

			<div class="mt-6 space-y-3">
				<h2 class="text-sm font-semibold text-[#e9ddc8]">Filters</h2>
				<select class="field" bind:value={filters.kind}>
					<option value="all">All evidence</option>
					<option value="screenshot">Screenshots</option>
					<option value="note">Notes</option>
				</select>
				<select class="field" bind:value={filters.tag}>
					<option value="">Any tag</option>
					{#each tags as tag}
						<option value={tag}>{tag}</option>
					{/each}
				</select>
				<select class="field" bind:value={filters.room}>
					<option value="">Any room</option>
					{#each rooms as room}
						<option value={room}>{room}</option>
					{/each}
				</select>
				<select class="field" bind:value={filters.puzzle}>
					<option value="">Any puzzle</option>
					{#each puzzles as puzzle}
						<option value={puzzle}>{puzzle}</option>
					{/each}
				</select>
			</div>
		</aside>

		<section class="min-w-0 p-4 {activeMobileTab === 'board' || activeMobileTab === 'search' ? 'block' : 'hidden'}">
			{#if visibleResults.length}
				<div class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
					{#each visibleResults as result (result.item.id)}
						<button
							class="evidence-card {selected?.id === result.item.id ? 'selected-card' : ''}"
							onclick={() => {
								selectedId = result.item.id;
								activeMobileTab = 'detail';
							}}
						>
							{#if result.item.thumbnail}
								<div class="relative">
									<img class="h-44 w-full object-cover" src={result.item.thumbnail} alt="" />
									<span class="absolute left-2 top-2 rounded bg-[#101820]/90 px-2 py-1 text-xs font-semibold text-[#f2d58d]">
										#{evidenceNumber(result.item)}
									</span>
								</div>
							{:else}
								<div class="relative flex h-44 items-center justify-center bg-[#202b32] px-4 text-center text-sm text-[#d7cfbd]">
									<span class="absolute left-2 top-2 rounded bg-[#101820]/90 px-2 py-1 text-xs font-semibold text-[#f2d58d]">
										#{evidenceNumber(result.item)}
									</span>
									{result.item.manualNotes || 'Text note'}
								</div>
							{/if}
							<div class="space-y-2 p-3 text-left">
								{#if result.item.kind === 'note'}
									<h2 class="line-clamp-2 text-sm font-semibold text-[#fff8e8]">{result.item.title}</h2>
								{/if}
								{#if cardDescription(result.item)}
									<p class="line-clamp-2 text-xs leading-5 text-[#b6c0bd]">{cardDescription(result.item)}</p>
								{/if}
								<div class="flex flex-wrap gap-1">
									{#if query}
										<span class="tag border-[#2c665f] text-[#bff0e4]">{Math.round(result.score * 100)}</span>
									{/if}
									{#each result.item.tags.slice(0, 3) as tag}
										<span class="tag">{tag}</span>
									{/each}
									{#if result.item.processingState !== 'complete'}
										<span class="tag border-[#715b33] text-[#eac77b]">{result.item.processingState}</span>
									{/if}
								</div>
							</div>
						</button>
					{/each}
				</div>
			{:else}
				<div class="flex min-h-96 items-center justify-center rounded border border-dashed border-[#53616a] bg-[#17212a] p-8 text-center">
					<div>
						<h2 class="text-lg font-semibold text-[#fff8e8]">No clues on the board yet</h2>
						<p class="mt-2 max-w-md text-sm text-[#aebbb7]">
							Paste a screenshot, drop image files, or add a quick note to start building your local clue index.
						</p>
					</div>
				</div>
			{/if}
		</section>

		<section class="min-w-0 p-4 {activeMobileTab === 'scratchpad' ? 'block' : 'hidden'}">
			<div class="grid h-full gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
				<label class="flex min-h-[60vh] flex-col text-sm font-semibold text-[#e9ddc8]">
					Scratchpad
					<textarea
						class="mt-2 min-h-[60vh] flex-1 resize-none rounded border border-[#3f4d55] bg-[#18222c] p-4 text-sm font-normal leading-6 text-[#fff8e8] outline-none ring-[#7db7aa] placeholder:text-[#7f8f91] focus:ring-2"
						placeholder="Write loose puzzle thoughts here. Reference evidence with #1, #2, #123..."
						bind:value={scratchpad}
					></textarea>
				</label>

				<div class="rounded border border-[#34414a] bg-[#151f28] p-4">
					<h2 class="text-sm font-semibold text-[#e9ddc8]">Linked references</h2>
					<div class="scratchpad-preview mt-3 text-sm leading-7 text-[#d3ddd8]">
						{#each scratchpadParts as part}
							{#if part.kind === 'ref'}
								{@const linkedItem = evidenceByNumber(part.number)}
								<button
									class="scratchpad-ref {linkedItem ? '' : 'missing-ref'}"
									disabled={!linkedItem}
									onclick={() => openEvidenceNumber(part.number)}
								>
									{part.text}
								</button>
							{:else}
								{part.text}
							{/if}
						{/each}
					</div>
				</div>
			</div>
		</section>

		<section class="min-w-0 p-4 {activeMobileTab === 'settings' ? 'block' : 'hidden'}">
			<div class="mx-auto max-w-3xl space-y-4">
				<div class="border-b border-[#34414a] pb-3">
					<h2 class="text-lg font-semibold text-[#fff8e8]">Settings</h2>
					<p class="mt-1 text-sm text-[#b7c3bf]">
						Choose where OCR and text embeddings run. Private backend calls go through this webapp's server API routes.
					</p>
				</div>

				<div class="settings-section">
					<div>
						<h3 class="text-sm font-semibold text-[#e9ddc8]">Private AI backend</h3>
						<p class="mt-1 text-xs leading-5 text-[#b7c3bf]">
							The backend hostname is configured with <code>AI_BACKEND_URL</code> on the deployed webapp server.
						</p>
					</div>
					<div class="mt-3 flex flex-wrap items-center gap-2">
						<button class="small-button" disabled={aiBackendChecking} onclick={checkAiBackend}>
							{aiBackendChecking ? 'Checking' : 'Check connection'}
						</button>
						{#if aiBackendStatus}
							<span class="text-xs text-[#b7c3bf]">{aiBackendStatus}</span>
						{/if}
					</div>
				</div>

				<div class="settings-section">
					<label class="detail-label" for="ocr-provider">
						OCR provider
						<select id="ocr-provider" class="field mt-1" bind:value={ocrProvider}>
							<option value="tesseract">Tesseract in browser</option>
							<option value="mistral">Mistral OCR</option>
							<option value="server">Private AI backend</option>
						</select>
					</label>

					{#if ocrProvider === 'mistral'}
						<label class="detail-label mt-3" for="mistral-key">
							Mistral API key
							<input
								id="mistral-key"
								class="field mt-1"
								type="password"
								autocomplete="off"
								placeholder="Stored locally in this browser"
								bind:value={mistralApiKey}
							/>
						</label>
						<p class="mt-2 text-xs leading-5 text-[#b7c3bf]">
							Mistral OCR sends screenshots to Mistral's API and may be billed by Mistral.
						</p>
					{:else if ocrProvider === 'server'}
						<p class="mt-2 text-xs leading-5 text-[#b7c3bf]">
							Screenshots are sent to your webapp server, then forwarded to the private AI backend.
						</p>
					{:else}
						<p class="mt-2 text-xs leading-5 text-[#b7c3bf]">Tesseract runs locally in the browser.</p>
					{/if}
				</div>

				<div class="settings-section">
					<label class="detail-label" for="text-embedding-provider">
						Text embedding provider
						<select id="text-embedding-provider" class="field mt-1" bind:value={textEmbeddingProvider}>
							<option value="browser">Browser model</option>
							<option value="server">Private AI backend</option>
						</select>
					</label>
					<p class="mt-2 text-xs leading-5 text-[#b7c3bf]">
						This affects new notes, re-indexed evidence, and search queries. Existing vectors keep working; use Index on an item to regenerate it.
					</p>
				</div>
			</div>
		</section>

		<aside class="workspace-panel {activeMobileTab === 'detail' ? 'block' : 'hidden'} md:block">
			{#if selected}
				<div class="flex items-center justify-between gap-3">
					<h2 class="text-base font-semibold text-[#fff8e8]">Evidence #{evidenceNumber(selected)}</h2>
					<div class="flex gap-2">
						<button class="small-button" onclick={retrySelected}>Index</button>
						<button class="small-button danger" onclick={removeSelected}>Delete</button>
					</div>
				</div>

				{#if selectedImageUrl}
					<div class="mt-4">
						<img
							class="max-h-[72vh] w-full rounded border border-[#3d4a52] object-contain bg-[#0b1117]"
							src={selectedImageUrl}
							alt=""
						/>
						<button class="mt-2 small-button" onclick={openOriginalImage}>Open full resolution</button>
					</div>
				{/if}

				<div class="mt-4 space-y-3">
					<label class="detail-label">
						Title
						<input class="field mt-1" value={selected.title} onchange={(event) => updateSelected({ title: event.currentTarget.value })} />
					</label>
					<div class="grid grid-cols-2 gap-3">
						<label class="detail-label">
							Room
							<input class="field mt-1" value={selected.room} onchange={(event) => updateSelected({ room: event.currentTarget.value })} />
						</label>
						<label class="detail-label">
							Puzzle
							<input class="field mt-1" value={selected.puzzle} onchange={(event) => updateSelected({ puzzle: event.currentTarget.value })} />
						</label>
					</div>
					<label class="detail-label">
						Tags
						<input
							class="field mt-1"
							value={selected.tags.join(', ')}
							placeholder="symbols, safe, chess"
							onchange={(event) => updateTags(event.currentTarget.value)}
						/>
					</label>
					<label class="detail-label">
						OCR text
						<textarea class="detail-textarea" value={selected.ocrText} onchange={(event) => updateSelected({ ocrText: event.currentTarget.value })}
						></textarea>
					</label>
					<label class="detail-label">
						Manual notes
						<textarea
							class="detail-textarea min-h-40"
							value={selected.manualNotes}
							onchange={(event) => updateSelected({ manualNotes: event.currentTarget.value })}
						></textarea>
					</label>
				</div>

				<div class="mt-4 rounded border border-[#3f4d55] bg-[#17212a] p-3 text-xs text-[#b7c3bf]">
					<p>Status: {selected.processingState}</p>
					{#if selected.processingMessage}<p>{selected.processingMessage}</p>{/if}
					{#if selected.error}<p class="text-[#f0a08f]">{selected.error}</p>{/if}
				</div>
			{:else}
				<div class="rounded border border-dashed border-[#53616a] p-6 text-sm text-[#aebbb7]">
					Select a clue to edit OCR text, notes, tags, and puzzle metadata.
				</div>
			{/if}
		</aside>
	</section>
</main>

<style>
	.workspace-panel {
		border-color: #2b3841;
		background: #151f28;
		padding: 1rem;
	}

	@media (min-width: 768px) {
		.workspace-panel {
			border-right-width: 1px;
		}

		.workspace-panel:last-child {
			border-left-width: 1px;
			border-right-width: 0;
		}
	}

	.icon-button,
	.text-button,
	.small-button {
		border: 1px solid #4d5c65;
		background: #1c2630;
		color: #f3eee3;
		font-weight: 600;
	}

	.icon-button {
		height: 2.75rem;
		width: 2.75rem;
		border-radius: 0.25rem;
		font-size: 1.35rem;
		line-height: 1;
	}

	.text-button {
		height: 2.75rem;
		border-radius: 0.25rem;
		padding: 0 0.85rem;
		font-size: 0.875rem;
	}

	.small-button {
		border-radius: 0.25rem;
		padding: 0.35rem 0.55rem;
		font-size: 0.75rem;
	}

	.danger {
		border-color: #7e4339;
		color: #ffc5b8;
	}

	.status-pill,
	.tag {
		border: 1px solid #41505a;
		border-radius: 999px;
		background: #18232c;
		padding: 0.2rem 0.5rem;
	}

	.tag {
		color: #bfd2cd;
		font-size: 0.68rem;
	}

	.drop-zone {
		cursor: pointer;
		border: 1px dashed #53616a;
		border-radius: 0.375rem;
		background: #17212a;
		padding: 1.2rem;
		text-align: center;
		transition:
			background 150ms ease,
			border-color 150ms ease;
	}

	.field {
		width: 100%;
		border: 1px solid #3f4d55;
		border-radius: 0.25rem;
		background: #18222c;
		padding: 0.62rem 0.7rem;
		color: #fff8e8;
		font-size: 0.875rem;
		outline: none;
	}

	.field:focus,
	.detail-textarea:focus {
		box-shadow: 0 0 0 2px #7db7aa;
	}

	.evidence-card {
		overflow: hidden;
		border: 1px solid #34414a;
		border-radius: 0.375rem;
		background: #18222c;
		transition:
			border-color 150ms ease,
			transform 150ms ease,
			background 150ms ease;
	}

	.evidence-card:hover,
	.selected-card {
		border-color: #c5a464;
		background: #1d2a32;
		transform: translateY(-1px);
	}

	.detail-label {
		display: block;
		color: #e9ddc8;
		font-size: 0.8rem;
		font-weight: 600;
	}

	.settings-section {
		border: 1px solid #34414a;
		border-radius: 0.375rem;
		background: #151f28;
		padding: 1rem;
	}

	code {
		border: 1px solid #3f4d55;
		border-radius: 0.25rem;
		background: #18222c;
		padding: 0.05rem 0.25rem;
		color: #f1d397;
	}

	.detail-textarea {
		margin-top: 0.25rem;
		min-height: 8rem;
		width: 100%;
		resize: vertical;
		border: 1px solid #3f4d55;
		border-radius: 0.25rem;
		background: #18222c;
		padding: 0.7rem;
		color: #fff8e8;
		font-size: 0.875rem;
		line-height: 1.5;
		outline: none;
	}

	.scratchpad-preview {
		white-space: pre-wrap;
	}

	.scratchpad-ref {
		border-radius: 0.25rem;
		background: #244844;
		padding: 0.08rem 0.28rem;
		color: #bff0e4;
		font-weight: 700;
	}

	.scratchpad-ref:hover {
		background: #2d5d57;
	}

	.missing-ref,
	.missing-ref:hover {
		cursor: not-allowed;
		background: #392b2d;
		color: #d89b90;
	}
</style>
