import { theme } from 'antd';

const CHARCOAL = '#141414';
const CHARCOAL_ALT = '#1f1f1f';

export function getAppTheme(isDark) {
  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: isDark
      ? {
          colorBgBase: CHARCOAL,
          colorBgLayout: CHARCOAL,
          colorBorder: 'rgba(255, 255, 255, 0.18)',
          colorBorderSecondary: 'rgba(255, 255, 255, 0.12)',
          borderRadius: 6,
          fontFamily:
            '"Source Sans 3", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
          fontFamilyCode:
            '"IBM Plex Mono", "Consolas", "Courier New", monospace',
          // #1677ff reads neon on charcoal
          colorPrimary: '#5b9bd5',
          colorPrimaryHover: '#7eb0df',
          colorPrimaryActive: '#4a87c0',
          colorInfo: '#8bb8e8',
          colorLink: '#8bb8e8',
          colorLinkHover: '#a8cdf0',
          controlOutline: 'rgba(91, 155, 213, 0.25)',
          colorBgTextHover: 'rgba(255, 255, 255, 0.08)',
          colorBgTextActive: 'rgba(255, 255, 255, 0.14)',
        }
      : {
          borderRadius: 6,
          fontFamily:
            '"Source Sans 3", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
          fontFamilyCode:
            '"IBM Plex Mono", "Consolas", "Courier New", monospace',
          // keep white cards distinct on grey shell
          colorBorder: 'rgba(33, 35, 48, 0.28)',
          colorBorderSecondary: 'rgba(33, 35, 48, 0.16)',
        },
    components: {
      Layout: isDark
        ? {
            // colorBg* aliases are deprecated; colorBgSider was never mapped
            headerBg: CHARCOAL,
            bodyBg: CHARCOAL,
            siderBg: CHARCOAL,
            triggerBg: CHARCOAL_ALT,
          }
        : {
            headerBg: '#ffffff',
            siderBg: '#ffffff',
            triggerBg: '#f5f5f5',
          },
      Menu: isDark
        ? {
            // Menu theme="dark" reads dark* tokens, not itemBg
            darkItemBg: CHARCOAL,
            darkSubMenuItemBg: CHARCOAL_ALT,
            darkPopupBg: CHARCOAL,
            darkItemSelectedColor: 'rgba(255, 255, 255, 0.85)',
            darkItemSelectedBg: 'rgba(255, 255, 255, 0.08)',
            darkItemHoverBg: 'rgba(255, 255, 255, 0.08)',
            itemBg: CHARCOAL,
            subMenuItemBg: CHARCOAL_ALT,
            menuSubMenuBg: CHARCOAL,
            horizontalItemSelectedColor: 'rgba(255, 255, 255, 0.85)',
            horizontalItemSelectedBg: 'transparent',
            itemSelectedColor: 'rgba(255, 255, 255, 0.85)',
            itemSelectedBg: 'rgba(255, 255, 255, 0.08)',
          }
        : {
            itemColor: 'rgba(0, 0, 0, 0.88)',
            horizontalItemSelectedColor: 'rgba(0, 0, 0, 0.88)',
            horizontalItemSelectedBg: 'transparent',
          },
      Collapse: isDark
        ? {}
        : {
            headerBg: '#ffffff',
            contentBg: '#ffffff',
            colorBorder: 'rgba(33, 35, 48, 0.22)',
          },
      Card: isDark
        ? {}
        : {
            colorBorderSecondary: 'rgba(33, 35, 48, 0.22)',
          },
      Tabs: isDark
        ? {}
        : {
            cardBg: 'rgba(255, 255, 255, 0.85)',
          },
    },
  };
}
