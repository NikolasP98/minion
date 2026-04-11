<script lang="ts">
	const CHANNELS = [
		{ name: 'Telegram', icon: '✈️' },
		{ name: 'Discord', icon: '🎮' },
		{ name: 'Slack', icon: '💬' },
		{ name: 'WhatsApp', icon: '📱' },
		{ name: 'iMessage', icon: '🍎' },
		{ name: 'Signal', icon: '🔒' },
		{ name: 'Teams', icon: '🏢' },
		{ name: 'Matrix', icon: '🔗' },
		{ name: 'Voice', icon: '🎙️' }
	];

	const FEATURES = [
		{
			title: 'All your channels, one AI',
			body: 'Connect Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Teams, Matrix, and Voice — all in one assistant.'
		},
		{
			title: 'Privacy-first architecture',
			body: 'Self-hosted or cloud. Your data stays yours. GDPR-compliant and built for the EU AI Act from day one.'
		},
		{
			title: 'Extensible by design',
			body: 'Plugin SDK for custom workflows. Open API for integrations. Built for developers and power users alike.'
		},
		{
			title: 'Enterprise ready',
			body: 'Role-based access, audit logs, and compliance tooling. Ready for teams of any size.'
		}
	];

	const productSchema = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'OpenClaw',
		alternateName: ['OpenClaw AI', 'OpenClaw assistant', 'OpenClaw MINION'],
		brand: { '@type': 'Brand', name: 'MINION' },
		manufacturer: {
			'@type': 'Organization',
			name: 'MINION',
			url: 'https://minion.ai'
		},
		url: 'https://minion.ai',
		downloadUrl: 'https://github.com/minion/minion',
		applicationCategory: 'AIApplication',
		operatingSystem: 'macOS, Windows, Linux',
		description:
			'OpenClaw by MINION is the official multi-channel personal AI assistant — Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Teams, Matrix, and Voice in one platform.',
		offers: {
			'@type': 'Offer',
			price: '0',
			priceCurrency: 'USD',
			description: 'Open-source, self-hostable'
		},
		review: {
			'@type': 'Review',
			reviewBody: 'OpenClaw by MINION is a fully open-source, self-hostable AI assistant.',
			author: { '@type': 'Organization', name: 'MINION' }
		}
	});
</script>

<svelte:head>
	<title>OpenClaw by MINION — Multi-Channel AI Assistant</title>
	<meta
		name="description"
		content="OpenClaw is the official AI assistant from MINION. Connect Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Teams, Matrix, and Voice — one AI, all channels. GDPR-compliant, EU AI Act ready, open-source."
	/>
	<meta name="keywords" content="OpenClaw AI, OpenClaw assistant, OpenClaw MINION, AI assistant, multi-channel AI, personal AI, Telegram bot, Discord bot, WhatsApp AI" />
	<link rel="canonical" href="https://minion.ai" />

	<!-- Open Graph -->
	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://minion.ai" />
	<meta property="og:title" content="OpenClaw by MINION — Multi-Channel AI Assistant" />
	<meta
		property="og:description"
		content="OpenClaw is the official AI assistant from MINION. 9 channels. One AI. Open-source and privacy-first."
	/>
	<meta property="og:image" content="https://minion.ai/og-home.png" />

	<!-- Twitter card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:site" content="@minionai" />
	<meta name="twitter:title" content="OpenClaw by MINION — Multi-Channel AI Assistant" />
	<meta
		name="twitter:description"
		content="The official OpenClaw AI assistant from MINION. 9 channels. One AI. Open-source and privacy-first."
	/>
	<meta name="twitter:image" content="https://minion.ai/og-home.png" />

	<!-- JSON-LD: SoftwareApplication (Product) -->
	{@html `<script type="application/ld+json">${productSchema}</script>`}
</svelte:head>

<!-- Hero -->
<section class="hero">
	<div class="container hero-inner">
		<div class="hero-badge">
			<a href="/openclaw">
				<span class="badge-dot"></span>
				Official OpenClaw — by MINION
			</a>
		</div>
		<h1>One AI assistant.<br />Every channel you live in.</h1>
		<p class="hero-sub">
			<strong>OpenClaw</strong> by MINION connects Telegram, Discord, Slack, WhatsApp, iMessage,
			Signal, Teams, Matrix, and Voice into a single, privacy-first AI assistant you control.
		</p>
		<div class="hero-actions">
			<a href="https://github.com/minion/minion" class="btn-cta" target="_blank" rel="noopener">
				Get OpenClaw — it's free
			</a>
			<a href="https://docs.minion.ai" class="btn-ghost" target="_blank" rel="noopener">
				Read the docs →
			</a>
		</div>
		<p class="hero-trust">
			Open-source · Self-hostable · GDPR-compliant · EU AI Act Article 50 ready
		</p>
	</div>
</section>

<!-- Channel grid -->
<section class="channels">
	<div class="container">
		<h2 class="section-label">Supported channels</h2>
		<ul class="channel-grid">
			{#each CHANNELS as ch}
				<li class="channel-chip">
					<span aria-hidden="true">{ch.icon}</span>
					{ch.name}
				</li>
			{/each}
		</ul>
	</div>
</section>

<!-- About OpenClaw (brand disambiguation) -->
<section class="about-openclaw" id="about-openclaw" aria-labelledby="about-openclaw-heading">
	<div class="container about-inner">
		<div class="about-text">
			<h2 id="about-openclaw-heading">OpenClaw™ — made by MINION</h2>
			<p>
				OpenClaw is the AI assistant platform built and maintained by <strong>MINION</strong>
				(minion.ai). It is open-source, self-hostable, and audited for security and privacy compliance.
			</p>
			<p>
				There is an unrelated open-source project that has recently adopted the "OpenClaw" name.
				That project is <em>not affiliated with MINION</em>. Security researchers have flagged it for
				infostealer behaviour. <a href="/openclaw">Learn how to tell the difference →</a>
			</p>
			<ul class="about-checks">
				<li>
					<span class="check" aria-hidden="true">✓</span>
					Official GitHub:
					<a href="https://github.com/minion/minion" target="_blank" rel="noopener"
						>github.com/minion/minion</a
					>
				</li>
				<li>
					<span class="check" aria-hidden="true">✓</span>
					Official docs:
					<a href="https://docs.minion.ai" target="_blank" rel="noopener">docs.minion.ai</a>
				</li>
				<li>
					<span class="check" aria-hidden="true">✓</span>
					Install with: <code>npm install -g @nikolasp98/minion</code>
				</li>
			</ul>
			<a href="/openclaw" class="btn-outline">Full brand &amp; security statement</a>
		</div>
		<aside class="about-card" aria-label="OpenClaw identity card">
			<div class="id-row"><span class="id-label">Product</span> <span>OpenClaw™</span></div>
			<div class="id-row"><span class="id-label">Company</span> <span>MINION (minion.ai)</span></div>
			<div class="id-row">
				<span class="id-label">Repo</span>
				<a href="https://github.com/minion/minion" target="_blank" rel="noopener"
					>github.com/minion/minion</a
				>
			</div>
			<div class="id-row">
				<span class="id-label">License</span> <span>AGPL-3.0</span>
			</div>
			<div class="id-row"><span class="id-label">Security</span> <span>GDPR · EU AI Act Art. 50</span></div>
			<div class="id-row"><span class="id-label">Docs</span> <a href="https://docs.minion.ai" target="_blank" rel="noopener">docs.minion.ai</a></div>
		</aside>
	</div>
</section>

<!-- Features -->
<section class="features">
	<div class="container">
		<h2 class="section-heading">Why OpenClaw?</h2>
		<div class="feature-grid">
			{#each FEATURES as f}
				<div class="feature-card">
					<h3>{f.title}</h3>
					<p>{f.body}</p>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- CTA strip -->
<section class="cta-strip">
	<div class="container cta-inner">
		<div>
			<h2>Ready to try the official OpenClaw?</h2>
			<p>Self-host in minutes. No vendor lock-in.</p>
		</div>
		<div class="cta-actions">
			<a href="https://github.com/minion/minion" class="btn-cta" target="_blank" rel="noopener">
				Get started on GitHub
			</a>
			<a href="https://docs.minion.ai" class="btn-ghost" target="_blank" rel="noopener">
				Documentation
			</a>
		</div>
	</div>
</section>

<style>
	/* Hero */
	.hero {
		padding: 96px 0 72px;
		text-align: center;
	}

	.hero-badge {
		margin-bottom: 20px;
	}

	.hero-badge a {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 14px;
		background: rgba(108, 99, 255, 0.15);
		border: 1px solid rgba(108, 99, 255, 0.35);
		border-radius: 999px;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-accent-light);
		text-decoration: none;
	}

	.hero-badge a:hover {
		background: rgba(108, 99, 255, 0.25);
		text-decoration: none;
	}

	.badge-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--color-success);
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}

	.hero h1 {
		font-size: clamp(2.2rem, 5vw, 3.5rem);
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--color-text);
		margin-bottom: 20px;
	}

	.hero-sub {
		max-width: 600px;
		margin: 0 auto 36px;
		color: var(--color-text-muted);
		font-size: 1.1rem;
		line-height: 1.7;
	}

	.hero-actions {
		display: flex;
		justify-content: center;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 20px;
	}

	.hero-trust {
		font-size: 0.8rem;
		color: var(--color-text-faint);
		letter-spacing: 0.02em;
	}

	/* Buttons */
	.btn-cta {
		padding: 12px 28px;
		background: var(--color-accent);
		color: #fff;
		border-radius: var(--radius-sm);
		font-weight: 700;
		font-size: 0.95rem;
		transition: background 0.15s, transform 0.1s;
	}

	.btn-cta:hover {
		background: var(--color-accent-light);
		text-decoration: none;
		transform: translateY(-1px);
	}

	.btn-ghost {
		padding: 12px 20px;
		color: var(--color-text-muted);
		font-weight: 600;
		font-size: 0.95rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		transition: border-color 0.15s, color 0.15s;
	}

	.btn-ghost:hover {
		border-color: var(--color-accent);
		color: var(--color-text);
		text-decoration: none;
	}

	.btn-outline {
		display: inline-block;
		margin-top: 20px;
		padding: 10px 20px;
		border: 1px solid var(--color-accent);
		color: var(--color-accent-light);
		border-radius: var(--radius-sm);
		font-size: 0.875rem;
		font-weight: 600;
		transition: background 0.15s;
	}

	.btn-outline:hover {
		background: rgba(108, 99, 255, 0.12);
		text-decoration: none;
	}

	/* Channels */
	.channels {
		padding: 40px 0 60px;
	}

	.section-label {
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-text-faint);
		margin-bottom: 16px;
		text-align: center;
	}

	.channel-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		justify-content: center;
	}

	.channel-chip {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 8px 16px;
		background: var(--color-bg-card);
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	/* About OpenClaw */
	.about-openclaw {
		padding: 72px 0;
		background: var(--color-bg-card);
		border-top: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
	}

	.about-inner {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 48px;
		align-items: start;
	}

	.about-text h2 {
		font-size: 1.75rem;
		margin-bottom: 16px;
	}

	.about-text p {
		color: var(--color-text-muted);
		margin-bottom: 16px;
		line-height: 1.7;
	}

	.about-checks {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 8px;
	}

	.about-checks li {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 0.9rem;
		color: var(--color-text-muted);
	}

	.check {
		color: var(--color-success);
		font-weight: 700;
	}

	.about-checks code {
		background: rgba(255, 255, 255, 0.06);
		padding: 2px 7px;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	.about-card {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		padding: 20px 24px;
		min-width: 280px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.id-row {
		display: flex;
		align-items: baseline;
		gap: 12px;
		font-size: 0.875rem;
		color: var(--color-text-muted);
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 10px;
	}

	.id-row:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}

	.id-label {
		font-weight: 700;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-faint);
		min-width: 64px;
	}

	/* Features */
	.features {
		padding: 80px 0;
	}

	.section-heading {
		font-size: 1.6rem;
		margin-bottom: 40px;
		text-align: center;
	}

	.feature-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 20px;
	}

	.feature-card {
		background: var(--color-bg-card);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		padding: 24px;
		transition: border-color 0.15s;
	}

	.feature-card:hover {
		border-color: var(--color-accent);
	}

	.feature-card h3 {
		font-size: 1rem;
		margin-bottom: 10px;
	}

	.feature-card p {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		line-height: 1.65;
	}

	/* CTA strip */
	.cta-strip {
		padding: 64px 0;
	}

	.cta-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 32px;
		flex-wrap: wrap;
	}

	.cta-inner h2 {
		font-size: 1.4rem;
		margin-bottom: 6px;
	}

	.cta-inner p {
		color: var(--color-text-muted);
		font-size: 0.9rem;
	}

	.cta-actions {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
	}

	@media (max-width: 768px) {
		.about-inner {
			grid-template-columns: 1fr;
		}

		.about-card {
			min-width: unset;
		}

		.cta-inner {
			flex-direction: column;
			text-align: center;
		}
	}
</style>
