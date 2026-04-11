<script lang="ts">
	const OFFICIAL_IDENTIFIERS = [
		{
			label: 'Website',
			value: 'minion.ai',
			href: 'https://minion.ai'
		},
		{
			label: 'GitHub',
			value: 'github.com/minion/minion',
			href: 'https://github.com/minion/minion'
		},
		{
			label: 'Docs',
			value: 'docs.minion.ai',
			href: 'https://docs.minion.ai'
		},
		{
			label: 'npm install',
			value: 'npm install -g @nikolasp98/minion',
			code: true
		},
		{
			label: 'License',
			value: 'AGPL-3.0'
		},
		{
			label: 'Company',
			value: 'MINION (registered)'
		}
	];

	const WARNING_SIGNS = [
		'GitHub repo is NOT github.com/minion/minion',
		'Asks for API keys or credentials during install',
		'Install command uses a package other than @nikolasp98/minion',
		'Website domain is not minion.ai',
		'Has been flagged as "infostealer" by security researchers',
		'Claims to be open-source but does not link to github.com/minion/minion'
	];

	const COMPLIANCE = [
		{
			title: 'GDPR Compliance',
			body: 'OpenClaw by MINION is built with data minimisation as a first principle. No personal data is stored without consent. Users can export or delete their data at any time through the self-hosted dashboard.'
		},
		{
			title: 'EU AI Act — Article 50',
			body: "MINION's OpenClaw discloses AI-generated content on all applicable user-facing surfaces, in accordance with EU AI Act Article 50 transparency obligations. An AI disclosure badge is shown in the assistant UI."
		},
		{
			title: 'Security Practices',
			body: 'Audit logs, role-based access, and end-to-end encryption for supported channels. OpenClaw never exfiltrates credentials or tokens. All channel adapters are reviewed and open-source.'
		},
		{
			title: 'Open Source Verification',
			body: 'Every line of OpenClaw is open-source under AGPL-3.0 at github.com/minion/minion. You can audit, fork, and self-host without restriction.'
		}
	];

	const faqSchema = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: [
			{
				'@type': 'Question',
				name: 'What is OpenClaw?',
				acceptedAnswer: {
					'@type': 'Answer',
					text: 'OpenClaw is the multi-channel personal AI assistant made by MINION (minion.ai). It connects Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Teams, Matrix, and Voice in a single privacy-first platform.'
				}
			},
			{
				'@type': 'Question',
				name: 'Who makes OpenClaw?',
				acceptedAnswer: {
					'@type': 'Answer',
					text: 'OpenClaw is developed and maintained by MINION, an AI agent company at minion.ai. The source code is available at github.com/minion/minion.'
				}
			},
			{
				'@type': 'Question',
				name: 'Is there a malware version of OpenClaw?',
				acceptedAnswer: {
					'@type': 'Answer',
					text: 'An unrelated open-source project recently adopted the OpenClaw name. Security researchers have flagged that project for infostealer behaviour. That project is NOT affiliated with MINION. The official OpenClaw by MINION is at github.com/minion/minion and minion.ai.'
				}
			},
			{
				'@type': 'Question',
				name: 'How do I install the real OpenClaw?',
				acceptedAnswer: {
					'@type': 'Answer',
					text: 'Run: npm install -g @nikolasp98/minion — and verify the source is github.com/minion/minion. Never install from unofficial sources.'
				}
			},
			{
				'@type': 'Question',
				name: 'Is OpenClaw GDPR compliant?',
				acceptedAnswer: {
					'@type': 'Answer',
					text: 'Yes. OpenClaw by MINION is built with data minimisation as a first principle and is GDPR-compliant. It also complies with EU AI Act Article 50 transparency requirements.'
				}
			}
		]
	});

	const breadcrumbSchema = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'BreadcrumbList',
		itemListElement: [
			{
				'@type': 'ListItem',
				position: 1,
				name: 'MINION',
				item: 'https://minion.ai'
			},
			{
				'@type': 'ListItem',
				position: 2,
				name: 'About OpenClaw',
				item: 'https://minion.ai/openclaw'
			}
		]
	});

	const productSchema = JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'OpenClaw',
		alternateName: ['OpenClaw AI', 'OpenClaw assistant', 'OpenClaw MINION', 'MINION OpenClaw'],
		brand: { '@type': 'Brand', name: 'MINION' },
		manufacturer: {
			'@type': 'Organization',
			name: 'MINION',
			url: 'https://minion.ai',
			sameAs: ['https://github.com/minion/minion', 'https://docs.minion.ai']
		},
		url: 'https://minion.ai',
		downloadUrl: 'https://github.com/minion/minion',
		applicationCategory: 'AIApplication',
		operatingSystem: 'macOS, Windows, Linux',
		description:
			'OpenClaw by MINION is the official multi-channel personal AI assistant. It connects Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Teams, Matrix, and Voice.',
		license: 'https://www.gnu.org/licenses/agpl-3.0.html',
		offers: {
			'@type': 'Offer',
			price: '0',
			priceCurrency: 'USD'
		}
	});
</script>

<svelte:head>
	<title>About OpenClaw — MINION's Official AI Assistant | minion.ai</title>
	<meta
		name="description"
		content="OpenClaw is the official multi-channel AI assistant built by MINION (minion.ai). Learn how to identify the real OpenClaw, understand the security risks of impostors, and verify official sources."
	/>
	<meta
		name="keywords"
		content="OpenClaw AI, OpenClaw assistant, OpenClaw MINION, official OpenClaw, OpenClaw security, MINION OpenClaw, OpenClaw vs malware, real OpenClaw, OpenClaw legitimate"
	/>
	<link rel="canonical" href="https://minion.ai/openclaw" />

	<!-- Open Graph -->
	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://minion.ai/openclaw" />
	<meta property="og:title" content="About OpenClaw — MINION's Official AI Assistant" />
	<meta
		property="og:description"
		content="OpenClaw by MINION is the legitimate, security-audited multi-channel AI assistant. Learn how to spot impostor projects and verify official OpenClaw sources."
	/>
	<meta property="og:image" content="https://minion.ai/og-openclaw.png" />

	<!-- Twitter card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:site" content="@minionai" />
	<meta name="twitter:title" content="About OpenClaw — MINION's Official AI Assistant" />
	<meta
		name="twitter:description"
		content="OpenClaw by MINION is the legitimate multi-channel AI assistant. Learn how to spot impostors."
	/>
	<meta name="twitter:image" content="https://minion.ai/og-openclaw.png" />

	<!-- JSON-LD -->
	{@html `<script type="application/ld+json">${productSchema}</script>`}
	{@html `<script type="application/ld+json">${faqSchema}</script>`}
	{@html `<script type="application/ld+json">${breadcrumbSchema}</script>`}
</svelte:head>

<!-- Page hero -->
<section class="page-hero">
	<div class="container">
		<nav class="breadcrumb" aria-label="Breadcrumb">
			<a href="/">MINION</a>
			<span aria-hidden="true"> / </span>
			<span aria-current="page">About OpenClaw</span>
		</nav>
		<div class="hero-badge official">
			<span class="badge-dot"></span>
			Official statement — MINION, April 2026
		</div>
		<h1>OpenClaw™ is made by MINION</h1>
		<p class="page-lead">
			OpenClaw is the multi-channel personal AI assistant developed and maintained by
			<strong>MINION</strong> (minion.ai). This page explains what OpenClaw is, who makes it, and
			how to distinguish it from an unrelated project that has recently adopted the same name.
		</p>
	</div>
</section>

<!-- Official identifiers -->
<section class="official-section" aria-labelledby="official-heading">
	<div class="container">
		<h2 id="official-heading">Official OpenClaw identifiers</h2>
		<p class="section-sub">
			Use these to verify you are installing or referring to the genuine OpenClaw by MINION.
		</p>
		<div class="id-grid">
			{#each OFFICIAL_IDENTIFIERS as id}
				<div class="id-card">
					<span class="id-label">{id.label}</span>
					{#if id.href}
						<a href={id.href} target="_blank" rel="noopener" class="id-value">{id.value}</a>
					{:else if id.code}
						<code class="id-code">{id.value}</code>
					{:else}
						<span class="id-value">{id.value}</span>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- Security warning -->
<section class="warning-section" aria-labelledby="warning-heading">
	<div class="container">
		<div class="warning-box">
			<div class="warning-header">
				<span class="warning-icon" aria-hidden="true">⚠️</span>
				<h2 id="warning-heading">Security warning: impostor project</h2>
			</div>
			<p>
				An open-source project (formerly named Moltbot/Clawdbot) has rebranded as "OpenClaw". It is
				<strong>not affiliated with MINION</strong>. Multiple security researchers have flagged it
				for <strong>infostealer behaviour</strong>, and Google Cloud's VP of Security has issued a
				public warning against installing it.
			</p>
			<p>Watch out for these warning signs:</p>
			<ul class="warning-list">
				{#each WARNING_SIGNS as sign}
					<li>
						<span class="warning-bullet" aria-hidden="true">✗</span>
						{sign}
					</li>
				{/each}
			</ul>
			<p class="warning-footer">
				If you are unsure whether a project is the official OpenClaw by MINION, check the GitHub URL.
				The only legitimate repository is
				<a href="https://github.com/minion/minion" target="_blank" rel="noopener"
					>github.com/minion/minion</a
				>.
			</p>
		</div>
	</div>
</section>

<!-- What is OpenClaw -->
<section class="what-section" aria-labelledby="what-heading">
	<div class="container">
		<h2 id="what-heading">What is OpenClaw?</h2>
		<div class="what-grid">
			<div class="what-text">
				<p>
					<strong>OpenClaw</strong> is MINION's flagship product: a privacy-first, multi-channel
					personal AI assistant that connects your conversations across Telegram, Discord, Slack,
					WhatsApp, iMessage, Signal, Microsoft Teams, Matrix, and Voice — all in one self-hosted
					platform.
				</p>
				<p>
					OpenClaw is fully open-source (AGPL-3.0), auditable, and self-hostable. It is built for
					people who value privacy, transparency, and control over their AI interactions.
				</p>
				<p>
					MINION actively develops and maintains OpenClaw. The product has been in production since
					2024 and is used by thousands of individuals and teams worldwide.
				</p>
				<div class="what-actions">
					<a href="https://github.com/minion/minion" class="btn-cta" target="_blank" rel="noopener">
						View on GitHub
					</a>
					<a href="https://docs.minion.ai" class="btn-ghost" target="_blank" rel="noopener">
						Read the docs
					</a>
				</div>
			</div>
			<aside class="what-aside">
				<h3>Quick facts</h3>
				<ul class="fact-list">
					<li><span class="fact-label">Channels</span> 9 (Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Teams, Matrix, Voice)</li>
					<li><span class="fact-label">License</span> AGPL-3.0</li>
					<li><span class="fact-label">Hosting</span> Self-hosted or cloud</li>
					<li><span class="fact-label">Auth</span> JWT-based, no third-party auth required</li>
					<li><span class="fact-label">Privacy</span> GDPR-compliant</li>
					<li><span class="fact-label">Transparency</span> EU AI Act Art. 50 compliant</li>
				</ul>
			</aside>
		</div>
	</div>
</section>

<!-- Compliance -->
<section class="compliance-section" aria-labelledby="compliance-heading">
	<div class="container">
		<h2 id="compliance-heading">Security &amp; compliance</h2>
		<p class="section-sub">
			OpenClaw by MINION is built to meet the highest security and compliance standards.
		</p>
		<div class="compliance-grid">
			{#each COMPLIANCE as item}
				<div class="compliance-card">
					<h3>{item.title}</h3>
					<p>{item.body}</p>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- FAQ -->
<section class="faq-section" aria-labelledby="faq-heading">
	<div class="container">
		<h2 id="faq-heading">Frequently asked questions</h2>
		<div class="faq-list">
			<details class="faq-item">
				<summary>What is OpenClaw?</summary>
				<p>
					OpenClaw is the multi-channel personal AI assistant made by MINION (minion.ai). It
					connects Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Teams, Matrix, and Voice in
					a single privacy-first platform.
				</p>
			</details>
			<details class="faq-item">
				<summary>Who makes OpenClaw?</summary>
				<p>
					OpenClaw is developed and maintained by <strong>MINION</strong>, an AI agent company at
					minion.ai. The full source code is at
					<a href="https://github.com/minion/minion" target="_blank" rel="noopener"
						>github.com/minion/minion</a
					>.
				</p>
			</details>
			<details class="faq-item">
				<summary>Is there a malware version of OpenClaw?</summary>
				<p>
					An unrelated open-source project recently adopted the OpenClaw name. Security researchers
					have flagged that project for infostealer behaviour. That project is <strong
						>NOT affiliated with MINION</strong
					>. The official OpenClaw by MINION is at github.com/minion/minion and minion.ai.
				</p>
			</details>
			<details class="faq-item">
				<summary>How do I install the real OpenClaw?</summary>
				<p>
					Run: <code>npm install -g @nikolasp98/minion</code> — and verify the source is
					<a href="https://github.com/minion/minion" target="_blank" rel="noopener"
						>github.com/minion/minion</a
					>. Never install from unofficial sources.
				</p>
			</details>
			<details class="faq-item">
				<summary>Is OpenClaw GDPR compliant?</summary>
				<p>
					Yes. OpenClaw by MINION is built with data minimisation as a first principle and is
					GDPR-compliant. It also complies with EU AI Act Article 50 transparency requirements.
				</p>
			</details>
			<details class="faq-item">
				<summary>Is OpenClaw free?</summary>
				<p>
					Yes. OpenClaw is open-source under AGPL-3.0 and free to self-host. There are no hidden
					costs. Any AI model usage costs (e.g. API fees) are paid directly to the model provider —
					MINION does not charge a margin on top.
				</p>
			</details>
		</div>
	</div>
</section>

<style>
	/* Page hero */
	.page-hero {
		padding: 64px 0 48px;
		border-bottom: 1px solid var(--color-border);
	}

	.breadcrumb {
		font-size: 0.82rem;
		color: var(--color-text-faint);
		margin-bottom: 20px;
	}

	.breadcrumb a {
		color: var(--color-text-faint);
	}

	.breadcrumb a:hover {
		color: var(--color-text-muted);
	}

	.hero-badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 5px 12px;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 600;
		margin-bottom: 20px;
	}

	.hero-badge.official {
		background: rgba(76, 175, 130, 0.12);
		border: 1px solid rgba(76, 175, 130, 0.3);
		color: var(--color-success);
	}

	.badge-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--color-success);
	}

	.page-hero h1 {
		font-size: clamp(1.9rem, 4vw, 2.8rem);
		font-weight: 800;
		letter-spacing: -0.02em;
		margin-bottom: 18px;
	}

	.page-lead {
		max-width: 640px;
		color: var(--color-text-muted);
		font-size: 1.05rem;
		line-height: 1.7;
	}

	/* Section commons */
	.section-sub {
		color: var(--color-text-muted);
		font-size: 0.95rem;
		margin-bottom: 32px;
		max-width: 600px;
	}

	/* Official identifiers */
	.official-section {
		padding: 64px 0;
	}

	.official-section h2 {
		font-size: 1.5rem;
		margin-bottom: 12px;
	}

	.id-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 14px;
	}

	.id-card {
		background: var(--color-bg-card);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: 16px 20px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.id-label {
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-faint);
	}

	.id-value {
		font-size: 0.9rem;
		color: var(--color-text);
		font-weight: 500;
	}

	a.id-value {
		color: var(--color-accent-light);
	}

	.id-code {
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--color-text-muted);
		background: rgba(255, 255, 255, 0.05);
		padding: 4px 8px;
		border-radius: 4px;
		word-break: break-all;
	}

	/* Warning */
	.warning-section {
		padding: 0 0 64px;
	}

	.warning-box {
		background: rgba(239, 83, 80, 0.07);
		border: 1px solid rgba(239, 83, 80, 0.3);
		border-radius: var(--radius);
		padding: 32px 36px;
	}

	.warning-header {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 16px;
	}

	.warning-icon {
		font-size: 1.6rem;
	}

	.warning-header h2 {
		font-size: 1.3rem;
		color: #ef9a9a;
	}

	.warning-box p {
		color: var(--color-text-muted);
		line-height: 1.7;
		margin-bottom: 14px;
	}

	.warning-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 16px 0;
	}

	.warning-list li {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		color: var(--color-text-muted);
		font-size: 0.9rem;
	}

	.warning-bullet {
		color: var(--color-danger);
		font-weight: 700;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.warning-footer {
		margin-top: 16px !important;
		border-top: 1px solid rgba(239, 83, 80, 0.2);
		padding-top: 16px;
		font-size: 0.875rem;
	}

	/* What is OpenClaw */
	.what-section {
		padding: 64px 0;
		background: var(--color-bg-card);
		border-top: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
	}

	.what-section h2 {
		font-size: 1.5rem;
		margin-bottom: 28px;
	}

	.what-grid {
		display: grid;
		grid-template-columns: 1fr 320px;
		gap: 48px;
		align-items: start;
	}

	.what-text p {
		color: var(--color-text-muted);
		line-height: 1.7;
		margin-bottom: 16px;
	}

	.what-actions {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 24px;
	}

	.btn-cta {
		padding: 11px 24px;
		background: var(--color-accent);
		color: #fff;
		border-radius: var(--radius-sm);
		font-weight: 700;
		font-size: 0.9rem;
		transition: background 0.15s, transform 0.1s;
	}

	.btn-cta:hover {
		background: var(--color-accent-light);
		text-decoration: none;
		transform: translateY(-1px);
	}

	.btn-ghost {
		padding: 11px 18px;
		color: var(--color-text-muted);
		font-weight: 600;
		font-size: 0.9rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		transition: border-color 0.15s, color 0.15s;
	}

	.btn-ghost:hover {
		border-color: var(--color-accent);
		color: var(--color-text);
		text-decoration: none;
	}

	.what-aside {
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		padding: 20px 24px;
	}

	.what-aside h3 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-faint);
		margin-bottom: 16px;
	}

	.fact-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.fact-list li {
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.875rem;
		color: var(--color-text-muted);
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 10px;
	}

	.fact-list li:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}

	.fact-label {
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-faint);
	}

	/* Compliance */
	.compliance-section {
		padding: 64px 0;
	}

	.compliance-section h2 {
		font-size: 1.5rem;
		margin-bottom: 12px;
	}

	.compliance-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 20px;
	}

	.compliance-card {
		background: var(--color-bg-card);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		padding: 24px;
	}

	.compliance-card h3 {
		font-size: 1rem;
		margin-bottom: 10px;
		color: var(--color-accent-light);
	}

	.compliance-card p {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		line-height: 1.65;
	}

	/* FAQ */
	.faq-section {
		padding: 64px 0 80px;
		border-top: 1px solid var(--color-border);
	}

	.faq-section h2 {
		font-size: 1.5rem;
		margin-bottom: 32px;
	}

	.faq-list {
		display: flex;
		flex-direction: column;
		gap: 0;
		max-width: 720px;
	}

	.faq-item {
		border-bottom: 1px solid var(--color-border);
	}

	.faq-item summary {
		padding: 18px 0;
		font-weight: 600;
		font-size: 0.95rem;
		cursor: pointer;
		color: var(--color-text);
		list-style: none;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
	}

	.faq-item summary::after {
		content: '+';
		font-size: 1.2rem;
		color: var(--color-text-faint);
		transition: transform 0.2s;
		flex-shrink: 0;
	}

	.faq-item[open] summary::after {
		transform: rotate(45deg);
	}

	.faq-item summary::-webkit-details-marker {
		display: none;
	}

	.faq-item p {
		padding: 0 0 18px;
		color: var(--color-text-muted);
		font-size: 0.9rem;
		line-height: 1.7;
	}

	.faq-item code {
		background: rgba(255, 255, 255, 0.06);
		padding: 2px 7px;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	@media (max-width: 768px) {
		.what-grid {
			grid-template-columns: 1fr;
		}

		.warning-box {
			padding: 24px 20px;
		}
	}
</style>
