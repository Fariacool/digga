import type { FC } from 'react';

import ToolLanding from '@/components/tool/tool-landing';
import { toolMetadata } from '@/lib/seo';

export function generateMetadata() {
	return toolMetadata('dns');
}

const Page: FC = () => <ToolLanding slug="dns" />;

export default Page;
