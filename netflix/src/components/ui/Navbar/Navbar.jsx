import { Brightness4, Brightness7 } from '@mui/icons-material';
import MenuIcon from '@mui/icons-material/Menu';
import { AppBar, Box, Container, Divider, Drawer, IconButton, Link, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Slide, Stack, Toolbar, Typography, useScrollTrigger } from '@mui/material';
import React, { useContext, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';



import { iconComponents, MOVIE_LISTS, TOP_LISTS } from '../../../constants.js';
import { ColorModeContext } from '../../../context/ToggleColorMode.jsx';
import Search from '../Search/index.js';


const Icon = ({ iconName }) => {
  const IconComponent = iconComponents[iconName];
  return <IconComponent />;
};

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const { toggleColorMode, mode } = useContext(ColorModeContext);
  const trigger = useScrollTrigger({
    target: window,
  });

  const handleDrawerToggle = () => {
    setIsOpen(prevState => !prevState);
  };

  return (
    <Slide appear={false} direction="down" in={!trigger}>
      <AppBar>
        <Container maxWidth="lg">
          <Toolbar>
            <IconButton color="inherit" onClick={handleDrawerToggle}>
              <MenuIcon />
            </IconButton>
            <Drawer open={isOpen} onClose={handleDrawerToggle}>
              <Box sx={{ width: 250 }} onClick={handleDrawerToggle}>
                <List>
                  {TOP_LISTS.map(item => (
                    <Link key={item.id} component={RouterLink} to={item.url}>
                      <ListItem disablePadding>
                        <ListItemButton>
                          <ListItemIcon>
                            <Icon iconName={item.icon} />
                          </ListItemIcon>
                          <ListItemText primary={item.title} />
                        </ListItemButton>
                      </ListItem>
                    </Link>
                  ))}
                </List>
                <Divider />
                <List>
                  {MOVIE_LISTS.map(item => (
                    <Link key={item.id} component={RouterLink} to={item.url}>
                      <ListItem disablePadding>
                        <ListItemButton>
                          <ListItemIcon>
                            <Icon iconName={item.icon} />
                          </ListItemIcon>
                          <ListItemText primary={item.title} />
                        </ListItemButton>
                      </ListItem>
                    </Link>
                  ))}
                </List>
              </Box>
            </Drawer>
            <Stack
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              width="100%"
            >
              <Typography
                sx={{ color: 'white', textDecoration: 'none' }}
                component={RouterLink}
                variant="h4"
                to="/"
              >
                Netflix
              </Typography>
              <Search />
              <IconButton color="inherit" onClick={toggleColorMode}>
                {mode === 'dark' ? <Brightness7 /> : <Brightness4 />}
              </IconButton>
            </Stack>
          </Toolbar>
        </Container>
      </AppBar>
    </Slide>
  );
};

export default Navbar;
