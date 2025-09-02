/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js}'],
  theme: {
    screens: {
      lg: {'max': '1999.99px'},
      md: {'max': '991.99px'},
      sm: {'max': '767.99px'},
      xs: {'max': '479.99px'},
    },
    extend: {
      fontFamily: {
        poppins: ['Poppins', 'sans-serif'],
        montserrat: ['Montserrat', 'sans-serif'],
      },
      backgroundImage: {
        heroGradient: 'linear-gradient(94.59deg, #4923B4 2.39%, #E878CF 97.66%)'
      },
      colors: {
        blueViolet: '#5027B5',
        lightGrey: '#666768',
      },
    },
  },
  plugins: [],
}
