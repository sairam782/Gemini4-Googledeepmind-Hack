import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { Brand, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** "Uno ReVoice" in the logo colours: coral Uno, ink Re, green Voice. */
export function Wordmark({ size = 36 }: { size?: number }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="header"
      accessibilityLabel="Uno ReVoice"
      style={[styles.word, { fontSize: size, lineHeight: size * 1.15 }]}>
      <Text style={{ color: Brand.coral }}>Uno </Text>
      <Text style={{ color: theme.text }}>Re</Text>
      <Text style={{ color: Brand.green }}>Voice</Text>
    </Text>
  );
}

export function Logo({ size = 56 }: { size?: number }) {
  return (
    <Image
      source={require('@/assets/images/logo.png')}
      style={{ width: size, height: size }}
      accessibilityIgnoresInvertColors
      accessible={false}
    />
  );
}

export function BrandHeader() {
  return (
    <View style={styles.header}>
      <Logo />
      <Wordmark />
    </View>
  );
}

const styles = StyleSheet.create({
  word: { fontWeight: '900', letterSpacing: -0.5 },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm + 4 },
});
