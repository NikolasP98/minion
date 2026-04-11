<script lang="ts">
	import '../app.css';

	const organizationSchema = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'Organization',
		name: 'MINION',
		url: 'https://minion.ai',
		logo: 'https://minion.ai/favicon.svg',
		description:
			'MINION is an AI agent company building OpenClaw, the multi-channel personal AI assistant platform.',
		sameAs: [
			'https://github.com/minion/minion',
			'https://docs.minion.ai',
			'https://twitter.com/minionai'
		],
		contactPoint: {
			'@type': 'ContactPoint',
			contactType: 'customer support',
			url: 'https://docs.minion.ai'
		}
	});

	const websiteSchema = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'WebSite',
		name: 'MINION — OpenClaw AI Assistant',
		url: 'https://minion.ai',
		description:
			'Official website of MINION and OpenClaw, the AI-powered multi-channel personal assistant.'
	});

	let { children } = $props();
</script>

<svelte:head>
	<!-- Site-wide meta -->
	<meta property="og:site_name" content="MINION" />
	<meta name="theme-color" content="#6c63ff" />

	<!-- JSON-LD: Organization -->
	{@html `<script type="application/ld+json">${organizationSchema}</script>`}
	<!-- JSON-LD: WebSite -->
	{@html `<script type="application/ld+json">${websiteSchema}</script>`}
</svelte:head>

<header class="site-header">
	<div class="container header-inner">
		<a href="/" class="logo" aria-label="MINION home">
			<svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
				<rect width="28" height="28" rx="7" fill="#6c63ff" />
				<path d="M7 20V8l7 6 7-6v12" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
			<span>MINION</span>
		</a>
		<nav aria-label="Main navigation">
			<ul>
				<li><a href="/">Home</a></li>
				<li><a href="/openclaw">About OpenClaw</a></li>
				<li><a href="https://docs.minion.ai" target="_blank" rel="noopener">Docs</a></li>
			</ul>
		</nav>
		<a href="https://github.com/minion/minion" class="btn-primary" target="_blank" rel="noopener">
			Get OpenClaw
		</a>
	</div>
</header>

{@render children()}

<footer class="site-footer">
	<div class="container footer-inner">
		<p class="footer-brand">© 2026 MINION · <a href="https://minion.ai">minion.ai</a></p>
		<nav aria-label="Footer navigation">
			<ul>
				<li><a href="/openclaw">About OpenClaw</a></li>
				<li><a href="https://docs.minion.ai" target="_blank" rel="noopener">Docs</a></li>
				<li><a href="https://github.com/minion/minion" target="_blank" rel="noopener">GitHub</a></li>
			</ul>
		</nav>
		<p class="footer-legal">
			OpenClaw™ is a trademark of MINION. <a href="/openclaw">Learn more about the official OpenClaw.</a>
		</p>
	</div>
</footer>

<style>
	.site-header {
		position: sticky;
		top: 0;
		z-index: 100;
		background: rgba(10, 10, 15, 0.92);
		backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--color-border);
	}

	.header-inner {
		display: flex;
		align-items: center;
		gap: 32px;
		height: 64px;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 10px;
		font-weight: 700;
		font-size: 1.1rem;
		color: var(--color-text);
		text-decoration: none;
		flex-shrink: 0;
	}

	.logo:hover {
		text-decoration: none;
		opacity: 0.85;
	}

	nav ul {
		display: flex;
		gap: 24px;
	}

	nav a {
		color: var(--color-text-muted);
		font-size: 0.9rem;
		font-weight: 500;
		transition: color 0.15s;
	}

	nav a:hover {
		color: var(--color-text);
		text-decoration: none;
	}

	.btn-primary {
		margin-left: auto;
		padding: 8px 18px;
		background: var(--color-accent);
		color: #fff;
		border-radius: var(--radius-sm);
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
		transition: background 0.15s, transform 0.1s;
	}

	.btn-primary:hover {
		background: var(--color-accent-light);
		text-decoration: none;
		transform: translateY(-1px);
	}

	.site-footer {
		margin-top: 80px;
		border-top: 1px solid var(--color-border);
		padding: 40px 0;
	}

	.footer-inner {
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: center;
		text-align: center;
	}

	.footer-brand {
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.footer-inner nav ul {
		gap: 20px;
	}

	.footer-inner nav a {
		font-size: 0.85rem;
	}

	.footer-legal {
		font-size: 0.8rem;
		color: var(--color-text-faint);
		max-width: 560px;
		line-height: 1.5;
	}
</style>
