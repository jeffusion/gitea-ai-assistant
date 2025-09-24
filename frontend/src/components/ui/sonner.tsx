import { Toaster as Sonner } from "sonner"
import * as React from "react"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  // In a Vite/React setup, we don't use next-themes.
  // The theme is passed directly via props from App.tsx.
  // const { theme = "system" } = useTheme()

  return (
    <Sonner
      className="toaster group"
      // theme={theme as ToasterProps["theme"]}  // Theme is controlled by props
      {...props}
    />
  )
}

export { Toaster }
