export const metadata = {
	title: "OCB Prom Admin",
	description: "Bounded delete + audit for the OpenChainBench Prometheus",
	robots: "noindex,nofollow",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#fafafa" }}>{children}</body>
		</html>
	);
}
