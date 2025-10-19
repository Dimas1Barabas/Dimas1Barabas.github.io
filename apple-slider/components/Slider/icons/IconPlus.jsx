const IconPlus = () => {
	return (
		<svg
			className="plus-icon"
			version="1.1"
			width="24px"
			height="24px"
			viewBox="0 0 24 24"
			xmlns="http://www.w3.org/2000/svg"
		>
			<circle
				cx="12"
				cy="12"
				r="11.3"
				// style="stroke: var(--app-pv-icon-fill); fill: none;"
				style={{
					stroke: 'var(--app-pv-icon-fill)',
					fill: 'none',
				}}
			></circle>
			<g
				transform="translate(7 7)"
				// style="stroke: none; fill: var(--app-pv-icon-fill);"
				style={{
					fill: 'var(--app-pv-icon-fill)',
					stroke: 'none',
				}}
			>
				<path d="m9 4h-3v-3c0-0.553-0.447-1-1-1s-1 0.447-1 1v3h-3c-0.553 0-1 0.447-1 1s0.447 1 1 1h3v3c0 0.553 0.447 1 1 1s1-0.447 1-1v-3h3c0.553 0 1-0.447 1-1s-0.447-1-1-1"></path>
			</g>
		</svg>
	);
}

export default IconPlus;
